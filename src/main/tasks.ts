import { spawn, IPty } from 'node-pty'
import { WebContents, app } from 'electron'
import { statSync } from 'fs'
import { readSettings, updateSettings } from './settings'
import { killProcessTree } from './proc'
import { createTerminalEnvironment } from './terminal-env'
import type { TaskDef, TaskMeta, TaskStatus } from '@shared/types'
import type { TaskOutputSnapshot } from '@shared/types'

export type { TaskDef, TaskMeta, TaskStatus }

const isWindows = process.platform === 'win32'

interface Task extends TaskMeta {
  pty: IPty | null
  // Ring buffer of raw output chunks (ANSI preserved). Capped by byte size so
  // a chatty dev server can't grow memory unbounded.
  output: string[]
  outputBytes: number
  outputSequence: number
  // Last known PTY grid size. Tracks the log viewer so full-screen TUIs
  // (Next.js overlay, vite menu) render aligned, and a re-run respawns at the
  // same size instead of the 120×30 default.
  cols: number
  rows: number
}

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

// 默认输出缓存上限(单位:字节)。用户可在设置里调到 1 MB–32 MB,这里给一个
// 较大的默认值 4 MB —— dev server 跑半天后用户希望能回看冷启动日志。原始
// 512 KB 太小,一次 install 就被冲掉。
const DEFAULT_OUTPUT_BYTE_CAP = 4 * 1024 * 1024
const MIN_OUTPUT_BYTE_CAP = 1024 * 1024
const MAX_OUTPUT_BYTE_CAP = 32 * 1024 * 1024

function outputByteCap(): number {
  const kb = readSettings().taskOutputCapKB
  if (typeof kb !== 'number' || !Number.isFinite(kb)) return DEFAULT_OUTPUT_BYTE_CAP
  return Math.max(MIN_OUTPUT_BYTE_CAP, Math.min(MAX_OUTPUT_BYTE_CAP, Math.floor(kb * 1024)))
}

const tasks = new Map<string, Task>()
// Renderers that want task stream/status events. Tasks outlive any single
// pane, so we broadcast to every live webContents that registered.
const subscribers = new Set<WebContents>()

function genId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function defaultShell(): string {
  if (isWindows) return process.env.COMSPEC || 'cmd.exe'
  // mac 默认 zsh,linux 仍 bash —— 见 shell.ts defaultShell 的同步注释。
  if (process.platform === 'darwin') return process.env.SHELL || '/bin/zsh'
  return process.env.SHELL || '/bin/bash'
}

function isValidDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function toMeta(t: Task): TaskMeta {
  return {
    id: t.id,
    name: t.name,
    command: t.command,
    cwd: t.cwd,
    status: t.status,
    exitCode: t.exitCode,
    startedAt: t.startedAt
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of Array.from(subscribers)) {
    if (wc.isDestroyed()) {
      subscribers.delete(wc)
      continue
    }
    wc.send(channel, payload)
  }
}

function persistDefs(): void {
  const defs: TaskDef[] = Array.from(tasks.values()).map((t) => ({
    id: t.id,
    name: t.name,
    command: t.command,
    cwd: t.cwd
  }))
  updateSettings({ tasks: defs })
}

export function registerTaskSubscriber(wc: WebContents): void {
  subscribers.add(wc)
  wc.once('destroyed', () => subscribers.delete(wc))
}

/** Load persisted task definitions on startup. Nothing is auto-run. */
export function loadPersistedTasks(): void {
  const defs = readSettings().tasks
  if (!Array.isArray(defs)) return
  for (const d of defs) {
    if (!d || !d.id || !d.command) continue
    tasks.set(d.id, {
      id: d.id,
      name: d.name || d.command,
      command: d.command,
      cwd: d.cwd || '',
      status: 'idle',
      exitCode: null,
      startedAt: null,
      pty: null,
      output: [],
      outputBytes: 0,
      outputSequence: 0,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS
    })
  }
}

export function listTasks(): TaskMeta[] {
  return Array.from(tasks.values()).map(toMeta)
}

export function getTaskOutput(id: string): TaskOutputSnapshot {
  const t = tasks.get(id)
  return t ? { output: t.output.join(''), sequence: t.outputSequence } : { output: '', sequence: 0 }
}

/**
 * Stop a task's PTY *and* every descendant it spawned. `pty.kill()` only
 * signals the shell wrapping the command, so `npm run dev`-style trees
 * (npm → node → vite/esbuild, or `nx run` → many worker processes) outlive
 * it and keep holding the port. We must snapshot + tear down the descendant
 * tree BEFORE killing the PTY — once the shell dies the OS reparents any
 * detached grandchildren to the system process and they become unreachable.
 */
async function killTaskTree(t: Task): Promise<void> {
  const pty = t.pty
  if (!pty) return
  const pid = pty.pid
  if (pid) {
    try {
      await killProcessTree(pid)
    } catch {
      // never let snapshot failure block the kill
    }
  }
  try {
    pty.kill()
  } catch {
    // already gone
  }
}

function appendOutput(t: Task, chunk: string): void {
  const cap = outputByteCap()
  t.output.push(chunk)
  t.outputBytes += chunk.length
  while (t.outputBytes > cap && t.output.length > 1) {
    const dropped = t.output.shift()!
    t.outputBytes -= dropped.length
  }
  // A single chunk larger than the cap (e.g. a giant console.log dump) would
  // otherwise stay in memory forever — the loop above never drops the last
  // chunk. Tail-trim it to fit so the cap is a real bound, not a soft hint.
  if (t.outputBytes > cap && t.output.length === 1) {
    const only = t.output[0]
    const tail = only.slice(only.length - cap)
    t.output[0] = tail
    t.outputBytes = tail.length
  }
}

function spawnPty(t: Task): void {
  // 与 shell.ts 一致用 app.getPath('home'):
  //   - Windows 没有 $HOME(应当是 %USERPROFILE%),旧代码 fallback 到 process.cwd()
  //     —— 在 packaged app 里是安装目录,task 跑过去会读不到 package.json,
  //     用户体感是"运行无效"。
  //   - app.getPath('home') 跨平台都返回用户家目录,与 PTY pane 的默认值统一。
  const cwd = t.cwd && isValidDir(t.cwd) ? t.cwd : app.getPath('home')
  const shell = defaultShell()
  // Run the command through the shell so users can use pipes, &&, env vars,
  // and `npm run x` resolves from node_modules/.bin. Login + interactive on
  // POSIX so the user's full PATH (nvm/homebrew/…) is sourced.
  const args = isWindows ? ['/d', '/s', '/c', t.command] : ['-l', '-i', '-c', t.command]

  // Per-task environment: a fresh copy (never the shared live process.env) with
  // PWD pinned to this task's cwd and the stale INIT_CWD dropped. Without this,
  // tools that trust $PWD/$INIT_CWD (npm) inherit whatever dir Electron was
  // launched from, so the same `npm run dev` in two folders looks identical.
  const env = createTerminalEnvironment(process.env)
  env.PWD = cwd
  delete env.INIT_CWD

  const pty = spawn(shell, args, {
    name: 'xterm-256color',
    cols: t.cols || DEFAULT_COLS,
    rows: t.rows || DEFAULT_ROWS,
    cwd,
    env,
    ...(isWindows ? { useConpty: true } : {})
  })

  t.pty = pty
  t.status = 'running'
  t.exitCode = null
  t.startedAt = Date.now()
  broadcast('task-status', toMeta(t))

  // Capture `pty` in the closures and guard against stale callbacks. On
  // restart, `killTaskTree` triggers the old pty's exit asynchronously — it
  // can arrive AFTER spawnPty has set t.pty to the new instance and
  // broadcast 'running'. Without this guard the stale onExit overwrites the
  // fresh status, leaving the UI showing 'exited'/'failed' on a task that
  // is in fact running. Same hazard for onData: a kill()'d pty can still
  // flush buffered output that would otherwise pollute the new buffer.
  pty.onData((data) => {
    if (t.pty !== pty) return
    appendOutput(t, data)
    broadcast('task-data', { id: t.id, chunk: data, sequence: ++t.outputSequence })
  })

  pty.onExit(({ exitCode }) => {
    if (t.pty !== pty) return
    t.pty = null
    t.exitCode = exitCode
    t.status = exitCode === 0 ? 'exited' : 'failed'
    broadcast('task-status', toMeta(t))
  })
}

export async function startTask(opts: {
  id?: string
  name?: string
  command?: string
  cwd?: string
}): Promise<TaskMeta> {
  // Existing task (re-run): reuse the record, reset output.
  let t = opts.id ? tasks.get(opts.id) : undefined
  if (t) {
    if (t.pty) {
      await killTaskTree(t)
      t.pty = null
    }
    if (opts.command) t.command = opts.command
    if (opts.name) t.name = opts.name
    if (opts.cwd) t.cwd = opts.cwd
    t.output = []
    t.outputBytes = 0
  } else {
    const command = opts.command || ''
    t = {
      id: opts.id || genId(),
      name: opts.name || command,
      command,
      cwd: opts.cwd || '',
      status: 'idle',
      exitCode: null,
      startedAt: null,
      pty: null,
      output: [],
      outputBytes: 0,
      outputSequence: 0,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS
    }
    tasks.set(t.id, t)
  }
  broadcast('task-cleared', { id: t.id })
  spawnPty(t)
  persistDefs()
  return toMeta(t)
}

/** Create a task *definition* without running it (used by the manager dialog). */
export function createTask(opts: { name?: string; command: string; cwd: string }): TaskMeta {
  const t: Task = {
    id: genId(),
    name: opts.name?.trim() || opts.command,
    command: opts.command,
    cwd: opts.cwd,
    status: 'idle',
    exitCode: null,
    startedAt: null,
    pty: null,
    output: [],
    outputBytes: 0,
    outputSequence: 0,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS
  }
  tasks.set(t.id, t)
  persistDefs()
  broadcast('task-status', toMeta(t))
  return toMeta(t)
}

// pty.kill() 成功不代表 onExit 一定很快到 —— 罕见情况(进程 ignore SIGTERM、
// Windows ConPty 异常、shell 仍在 flush)会让 status 永远卡在 'running',UI
// 看起来"停不下来"。killProcessTree 已经把孙子杀光,shell 孤立后通常秒退,
// 这里 3 秒兜底:还没收到 exit 就强制广播 exited。onExit 真姗姗来迟也无害,
// onData/onExit 都有 `t.pty !== pty` 守护,旧实例的回调被识别为过期忽略。
const STOP_TIMEOUT_MS = 3000

export async function stopTask(id: string): Promise<void> {
  const t = tasks.get(id)
  if (!t || !t.pty) return
  const pid = t.pty.pid
  // Snapshot + reap the descendant tree BEFORE pty.kill() — otherwise the
  // shell's children (dev servers, watchers, Nx executor workers) get
  // reparented and survive. Awaiting here costs ~300ms (PowerShell start)
  // but is what actually catches detached survivors.
  if (pid) {
    try {
      await killProcessTree(pid)
    } catch {
      // never let snapshot failure block the kill
    }
  }
  const ptyAtKill = t.pty
  let threw = false
  try {
    t.pty.kill()
  } catch {
    threw = true
  }
  if (threw) {
    // kill() threw → the process was already gone; onExit won't fire, so
    // settle the status manually.
    t.pty = null
    t.status = 'exited'
    broadcast('task-status', toMeta(t))
    return
  }
  const timer = setTimeout(() => {
    // 旧 pty 还指着自己 → onExit 没来过。把指针拆掉、广播 exited。
    if (t.pty !== ptyAtKill) return
    t.pty = null
    t.status = 'exited'
    broadcast('task-status', toMeta(t))
  }, STOP_TIMEOUT_MS)
  // 别让兜底定时器阻挡 app 退出 —— before-quit 的 cleanup 不应该等这 3 秒。
  timer.unref?.()
}

/** Forward keystrokes/paste from the log viewer to a running task's PTY. */
export function writeTask(id: string, data: string): void {
  const t = tasks.get(id)
  if (t && t.pty) t.pty.write(data)
}

/**
 * Resize a task's PTY to match the log viewer. Stored on the task so a later
 * re-run respawns at the same size. No-op for non-positive dims.
 */
export function resizeTask(id: string, cols: number, rows: number): void {
  if (!(cols > 0 && rows > 0)) return
  const t = tasks.get(id)
  if (!t) return
  t.cols = cols
  t.rows = rows
  if (t.pty) {
    try {
      t.pty.resize(cols, rows)
    } catch {
      // pty may have exited between the check and the resize
    }
  }
}

export async function restartTask(id: string): Promise<TaskMeta | null> {
  const t = tasks.get(id)
  if (!t) return null
  return startTask({ id: t.id })
}

export async function removeTask(id: string): Promise<void> {
  const t = tasks.get(id)
  if (!t) return
  if (t.pty) await killTaskTree(t)
  tasks.delete(id)
  persistDefs()
  broadcast('task-removed', { id })
}

/**
 * 刪除所有 cwd 匹配指定路徑的任務。用於刪除工作樹時同步清理該目錄下的後台任務。
 *
 * 路徑規範化:統一用 `/`、去尾 `/`、Windows 忽略大小寫。
 * 匹配規則:任務的 cwd 規範化後以目標路徑開頭(即任務在該目錄或其子目錄下)。
 */
function normPath(p: string): string {
  let s = (p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (isWindows) s = s.toLowerCase()
  return s
}

export async function removeTasksByCwd(cwd: string): Promise<number> {
  const target = normPath(cwd)
  if (!target) return 0
  const ids: string[] = []
  for (const t of tasks.values()) {
    const tc = normPath(t.cwd)
    if (tc === target || tc.startsWith(target + '/')) {
      ids.push(t.id)
    }
  }
  if (!ids.length) return 0
  // 先停掉所有正在運行的,再統一刪除。
  const running = ids.map((id) => tasks.get(id)!).filter((t) => t.pty)
  await Promise.all(running.map((t) => killTaskTree(t)))
  for (const id of ids) {
    tasks.delete(id)
    broadcast('task-removed', { id })
  }
  persistDefs()
  return ids.length
}

export function updateTask(
  id: string,
  patch: { name?: string; command?: string; cwd?: string }
): TaskMeta | null {
  const t = tasks.get(id)
  if (!t) return null
  if (typeof patch.name === 'string') t.name = patch.name
  if (typeof patch.command === 'string') t.command = patch.command
  if (typeof patch.cwd === 'string') t.cwd = patch.cwd
  persistDefs()
  broadcast('task-status', toMeta(t))
  return toMeta(t)
}

/**
 * Kill every running task — called on app quit so no orphans linger.
 * Awaiting here gives the descendant-tree snapshot time to finish before
 * Electron tears the main process down (otherwise the snapshot's child
 * PowerShell would be reaped mid-query and survivors would be left behind).
 */
export async function killAllTasks(): Promise<void> {
  await Promise.all(
    Array.from(tasks.values())
      .filter((t) => t.pty)
      .map((t) => killTaskTree(t))
  )
}
