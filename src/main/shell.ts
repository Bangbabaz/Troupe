import { spawn, IPty } from 'node-pty'
import { WebContents, app, safeStorage } from 'electron'
import { execFile } from 'child_process'
import { randomBytes, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { readlinkSync, statSync, readFileSync, existsSync } from 'fs'
import { readFile, rm, writeFile } from 'fs/promises'
import { basename, dirname, join, relative, resolve } from 'path'
import { shellIntegration } from './shell-integration'
import { AGENT_MCP_PORT, BROWSER_MCP_PORT, TERMINAL_MCP_PORT } from './mcp-config'
import { killProcessTree } from './proc'
import { readSettings } from './settings'
import type {
  BranchInfo,
  WorktreeInfo,
  MergeOpKind,
  MergeStatus,
  ConflictedFile,
  ConflictVersions,
  CommitInfo,
  CommitDetail,
  CommitLogOpts,
  GitInfo,
  GitResult,
  GitResultWithWarning,
  DiffPayload,
  DiffStats,
  WorktreeAddOpts,
  PtyStartOpts,
  SshProfile
} from '@shared/types'

// Re-export 给同包内继续 import 的现状代码,迁移到共享类型不破坏现状。
export type {
  BranchInfo,
  WorktreeInfo,
  MergeOpKind,
  MergeStatus,
  ConflictedFile,
  CommitInfo,
  CommitDetail
}

const execFileP = promisify(execFile)

const isWindows = process.platform === 'win32'

interface Session {
  pty: IPty
  webContents: WebContents
  // Cached at creation: reading webContents.id after the wc is destroyed throws.
  wcId: number
  paneId: string
  kind: 'local' | 'ssh'
  cwd: string
  sshProfileId?: string
  sshTarget?: string
  sshLabel?: string
  terminalMcpToken?: string
  disposed: boolean
  sessionId: number
  sequence: number
  pendingData: string[]
  pendingLength: number
  flushTimer: ReturnType<typeof setTimeout> | null
  unacked: Map<number, number>
  unackedLength: number
  paused: boolean
  sshPassword?: string
  sshPromptTail: string
  sshPasswordSent: boolean
  outputBuffer: string
  outputStartCursor: number
  outputEndCursor: number
}

// One session per pane. Multiple panes can live on a single webContents.
const sessions = new Map<string, Session>()
// webContents.id → set of paneIds that belong to it. Used to clean up every
// pane when the renderer goes away.
const sessionsByWebContents = new Map<number, Set<string>>()
// webContents.id we've already wired a 'destroyed' handler on, so we don't
// stack duplicate handlers when multiple panes spawn on the same renderer.
const destroyHandlerInstalled = new Set<number>()
let nextSessionId = 1
const OUTPUT_BATCH_DELAY_MS = 5
const OUTPUT_BATCH_MAX_CHARS = 64 * 1024
const OUTPUT_PAUSE_HIGH_WATER = 1024 * 1024
const OUTPUT_RESUME_LOW_WATER = 256 * 1024
const OUTPUT_HISTORY_MAX_CHARS = 512 * 1024

// Common options for synchronous-style git invocations. encoding:'utf8' makes
// stdout/stderr come back as strings instead of Buffers.
const GIT_OPTS = { encoding: 'utf8' as const, timeout: 10_000, windowsHide: true }

interface ExecFailure {
  stdout?: string
  stderr?: string
  message: string
}

function cleanGitError(err: unknown): string {
  const e = err as ExecFailure
  // execFile rejects with an Error that has stderr/stdout attached
  const msg = (e?.stderr || e?.stdout || e?.message || String(err)).toString()
  return msg.replace(/^Command failed:[^\n]*\n?/, '').trim()
}

function defaultShell(): string {
  if (isWindows) {
    // Default to Windows PowerShell on Windows. PowerShell ships with every
    // modern Windows install (5.1 in System32, 7+ as `pwsh` if installed) and
    // gives users a richer prompt + tab-completion than cmd.exe. The user can
    // override via GITTIM_SHELL if they prefer cmd, pwsh, or git-bash.
    return process.env.GITTIM_SHELL || 'powershell.exe'
  }
  // macOS Catalina+(2019)默认 shell 是 zsh,bash 已被 Apple 标记为 deprecated。
  // 实际触发概率很低(process.env.SHELL 一般都设了);但 fallback 用 zsh 比 bash
  // 更贴合现代 mac 用户的预期 —— shell-integration 也是为 zsh 路径准备的全套
  // .zshenv/.zprofile/.zshrc wrapper。Linux 上 bash 仍然是普遍默认。
  if (process.platform === 'darwin') return process.env.SHELL || '/bin/zsh'
  return process.env.SHELL || '/bin/bash'
}

export function getCurrentDir(): string {
  // Default to the user's home directory. `process.cwd()` is whatever
  // directory the Electron process was launched from — in a packaged build
  // that's the install location, which is never what the user wants.
  return app.getPath('home')
}

function isValidDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function singleLineLabel(value: string): string {
  return Array.from(value, (char) => {
    const code = char.codePointAt(0) || 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : char
  })
    .join('')
    .trim()
    .slice(0, 160)
}

function findSshProfile(profileId: string | undefined): SshProfile | null {
  if (!profileId) return null
  const profiles = readSettings().sshProfiles || []
  return profiles.find((profile) => profile.id === profileId) || null
}

function decryptSshPassword(secret: string | undefined): string | undefined {
  if (!secret) return undefined
  try {
    if (secret.startsWith('safe:')) {
      return safeStorage.decryptString(Buffer.from(secret.slice(5), 'base64'))
    }
    if (secret.startsWith('plain:')) {
      return Buffer.from(secret.slice(6), 'base64').toString('utf8')
    }
  } catch {
    return undefined
  }
  return undefined
}

function buildSshSpawn(opts: PtyStartOpts): {
  shell: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  password?: string
  target: string
  label: string
} {
  const profile = findSshProfile(opts.sshProfileId)
  if (!profile) throw new Error('SSH 连接配置不存在')
  const host = String(profile.host || '').trim()
  const username = String(profile.username || '').trim()
  const port = Math.max(1, Math.min(65535, Math.round(profile.port || 22)))
  if (!host) throw new Error('SSH host 不能为空')
  if (!username) throw new Error('SSH username 不能为空')

  const args = ['-tt', '-p', String(port), `${username}@${host}`]
  const remoteCwd = profile.remoteCwd?.trim()
  if (remoteCwd) {
    const quoted = shellQuotePosix(remoteCwd)
    args.push(
      `if ! cd -- ${quoted}; then printf '\\033[33m[Gittim] remote directory not found: %s\\033[0m\\n' ${quoted}; fi; exec "\${SHELL:-/bin/sh}" -l`
    )
  }
  return {
    shell: isWindows ? 'ssh.exe' : 'ssh',
    args,
    cwd: getCurrentDir(),
    env: { ...process.env },
    password: decryptSshPassword(profile.passwordSecret) || profile.password,
    target: JSON.stringify([username, host.toLowerCase(), port, remoteCwd || '']),
    label: singleLineLabel(profile.name || `${username}@${host}`) || 'SSH'
  }
}

export function startPty(webContents: WebContents, opts: PtyStartOpts): void {
  const { paneId } = opts
  if (!paneId) throw new Error('startPty requires a paneId')

  // If a stale session exists for this paneId (shouldn't happen, but defensive), kill it.
  killPty(paneId)

  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24
  let shell: string
  let args: string[]
  let env: NodeJS.ProcessEnv
  let cwd: string
  let sshPassword: string | undefined
  let sshTarget: string | undefined
  let sshLabel: string | undefined
  let terminalMcpToken: string | undefined

  if (opts.kind === 'ssh') {
    const ssh = buildSshSpawn(opts)
    shell = ssh.shell
    args = ssh.args
    env = ssh.env
    cwd = ssh.cwd
    sshPassword = ssh.password
    sshTarget = ssh.target
    sshLabel = ssh.label
  } else {
    // Validate the requested cwd. A persisted layout can reference a folder
    // that's since been deleted — silently fall back to the user's home dir
    // rather than failing the spawn.
    cwd = opts.cwd && isValidDir(opts.cwd) ? opts.cwd : getCurrentDir()

    // Shell integration injects an OSC 7 cwd-notification hook so PaneToolbar
    // can follow `cd` commands. Falls back to passthrough for unknown shells.
    const local = shellIntegration(defaultShell())
    shell = local.shell
    args = local.args
    env = local.env
    terminalMcpToken = randomBytes(32).toString('hex')

    // 注入 paneId 和两个 MCP 端口，让 Agent 子进程能区分协作与浏览器端点。
    env.GITTIM_PANE_ID = opts.paneId
    // 兼容旧版本：通用变量仍指向原有的浏览器 MCP 端口。
    env.GITTIM_MCP_PORT = String(BROWSER_MCP_PORT)
    env.GITTIM_AGENT_MCP_PORT = String(AGENT_MCP_PORT)
    env.GITTIM_BROWSER_MCP_PORT = String(BROWSER_MCP_PORT)
    env.GITTIM_TERMINAL_MCP_PORT = String(TERMINAL_MCP_PORT)
    env.GITTIM_TERMINAL_MCP_TOKEN = terminalMcpToken
    env.GITTIM_AGENT_MCP_URL = `http://127.0.0.1:${AGENT_MCP_PORT}/sse?paneId=${encodeURIComponent(opts.paneId)}`
    env.GITTIM_BROWSER_MCP_URL = `http://127.0.0.1:${BROWSER_MCP_PORT}/sse`
    env.GITTIM_TERMINAL_MCP_URL = `http://127.0.0.1:${TERMINAL_MCP_PORT}/sse?paneId=${encodeURIComponent(opts.paneId)}&token=${terminalMcpToken}`
    env.GITTIM_AGENT_MCP_HTTP_URL = `http://127.0.0.1:${AGENT_MCP_PORT}/mcp?paneId=${encodeURIComponent(opts.paneId)}`
    env.GITTIM_BROWSER_MCP_HTTP_URL = `http://127.0.0.1:${BROWSER_MCP_PORT}/mcp`
    env.GITTIM_TERMINAL_MCP_HTTP_URL = `http://127.0.0.1:${TERMINAL_MCP_PORT}/mcp?paneId=${encodeURIComponent(opts.paneId)}&token=${terminalMcpToken}`
  }

  // node-pty's `name` option sets TERM on Unix, but on Windows it only labels
  // the PTY object. Advertise the emulated terminal explicitly so full-screen
  // clients enable capabilities such as bracketed paste under ConPTY.
  if (isWindows) {
    env.TERM ||= 'xterm-256color'
    env.COLORTERM ||= 'truecolor'
  }

  const pty = spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: env as { [key: string]: string },
    ...(isWindows ? { useConpty: true } : {})
  })

  const wcId = webContents.id
  const session: Session = {
    pty,
    webContents,
    wcId,
    paneId,
    kind: opts.kind === 'ssh' ? 'ssh' : 'local',
    cwd,
    sshProfileId: opts.kind === 'ssh' ? opts.sshProfileId : undefined,
    sshTarget,
    sshLabel,
    terminalMcpToken,
    disposed: false,
    sessionId: nextSessionId++,
    sequence: 0,
    pendingData: [],
    pendingLength: 0,
    flushTimer: null,
    unacked: new Map(),
    unackedLength: 0,
    paused: false,
    sshPassword,
    sshPromptTail: '',
    sshPasswordSent: false,
    outputBuffer: '',
    outputStartCursor: 0,
    outputEndCursor: 0
  }
  sessions.set(paneId, session)

  let set = sessionsByWebContents.get(wcId)
  if (!set) {
    set = new Set()
    sessionsByWebContents.set(wcId, set)
  }
  set.add(paneId)

  // Install destroy handler once per webContents — when the renderer dies,
  // kill every pane that belongs to it.
  if (!destroyHandlerInstalled.has(wcId)) {
    destroyHandlerInstalled.add(wcId)
    webContents.once('destroyed', () => {
      const ids = sessionsByWebContents.get(wcId)
      if (ids) {
        for (const id of Array.from(ids)) killPty(id)
        sessionsByWebContents.delete(wcId)
      }
      destroyHandlerInstalled.delete(wcId)
    })
  }

  const flushOutput = (): void => {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (!session.pendingLength || session.disposed || webContents.isDestroyed()) return
    const data = session.pendingData.join('')
    session.pendingData = []
    session.pendingLength = 0
    const sequence = ++session.sequence
    session.unacked.set(sequence, data.length)
    session.unackedLength += data.length
    webContents.send('pty-data', {
      paneId,
      data,
      sessionId: session.sessionId,
      sequence
    })
    if (!session.paused && session.unackedLength >= OUTPUT_PAUSE_HIGH_WATER) {
      session.paused = true
      session.pty.pause()
    }
  }

  pty.onData((data) => {
    if (session.disposed || webContents.isDestroyed()) return
    if (session.kind === 'ssh') {
      session.outputBuffer += data
      session.outputEndCursor += data.length
      if (session.outputBuffer.length > OUTPUT_HISTORY_MAX_CHARS) {
        const overflow = session.outputBuffer.length - OUTPUT_HISTORY_MAX_CHARS
        session.outputBuffer = session.outputBuffer.slice(overflow)
        session.outputStartCursor += overflow
      }
    }
    if (session.sshPassword && !session.sshPasswordSent) {
      session.sshPromptTail = (session.sshPromptTail + data).slice(-512)
      if (/password:\s*$/i.test(session.sshPromptTail)) {
        session.sshPasswordSent = true
        session.pty.write(`${session.sshPassword}\r`)
      }
    }
    session.pendingData.push(data)
    session.pendingLength += data.length
    if (session.pendingLength >= OUTPUT_BATCH_MAX_CHARS) {
      flushOutput()
    } else if (!session.flushTimer) {
      session.flushTimer = setTimeout(flushOutput, OUTPUT_BATCH_DELAY_MS)
    }
  })

  pty.onExit(({ exitCode }) => {
    flushOutput()
    if (!session.disposed && !webContents.isDestroyed()) {
      webContents.send('pty-exit', { paneId, exitCode })
    }
    session.disposed = true
    sessions.delete(paneId)
    sessionsByWebContents.get(wcId)?.delete(paneId)
  })
}

export function acknowledgePtyData(paneId: string, sessionId: number, sequence: number): void {
  const session = sessions.get(paneId)
  if (!session || session.disposed || session.sessionId !== sessionId) return
  const length = session.unacked.get(sequence)
  if (length === undefined) return
  session.unacked.delete(sequence)
  session.unackedLength = Math.max(0, session.unackedLength - length)
  if (session.paused && session.unackedLength <= OUTPUT_RESUME_LOW_WATER) {
    session.paused = false
    session.pty.resume()
  }
}

export function writePty(paneId: string, data: string): void {
  const session = sessions.get(paneId)
  if (session && !session.disposed) {
    session.pty.write(data)
  }
}

export function resizePty(paneId: string, cols: number, rows: number): void {
  const session = sessions.get(paneId)
  if (session && !session.disposed) {
    try {
      session.pty.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      // pty may have already exited
    }
  }
}

export async function killPty(paneId: string): Promise<void> {
  const session = sessions.get(paneId)
  if (!session) return
  session.disposed = true
  if (session.flushTimer) {
    clearTimeout(session.flushTimer)
    session.flushTimer = null
  }
  const pid = session.pty.pid
  // Reap the descendant tree FIRST. On Windows we need a live snapshot of
  // the process tree before pty.kill() reparents detached grandchildren
  // (Nx workers, vite/esbuild helpers, dev servers) to the system process,
  // at which point taskkill /T can no longer reach them.
  if (pid) {
    try {
      await killProcessTree(pid)
    } catch {
      // never let a stuck snapshot block PTY teardown
    }
  }
  try {
    session.pty.kill()
  } catch {
    // ignore — process may have exited during the snapshot
  }
  sessions.delete(paneId)
  sessionsByWebContents.get(session.wcId)?.delete(paneId)
}

/**
 * Kill every live PTY pane and its descendant tree. Called from `before-quit`
 * so dev servers / Claude Code / vim 等长期 PTY 子进程不会在 Gittim 关闭后逃逸。
 *
 * 不能依赖 webContents.once('destroyed') 兜底:`before-quit` 触发时 main 已经
 * 在收尾,destroy handler 内调用的 killPty 是 async 但不被 await,
 * killProcessTree 内部还要起 PowerShell snapshot —— main 退出会直接打断它们。
 * 这里同 killAllTasks 一样 await 完整个清理。
 */
export async function killAllPtyTrees(): Promise<void> {
  const ids = Array.from(sessions.keys())
  await Promise.all(ids.map((id) => killPty(id)))
}

/** 获取 pane 对应的 webContents(供 MCP server 推送浏览器激活事件)。 */
export function getPtyWebContents(paneId: string): WebContents | null {
  const session = sessions.get(paneId)
  if (!session || session.disposed) return null
  return session.webContents
}

/** 获取所有仍然存活的终端面板 ID，供内置 MCP 做目标发现。 */
export function getActivePtyPaneIds(): string[] {
  return Array.from(sessions.values())
    .filter((session) => !session.disposed && !session.webContents.isDestroyed())
    .map((session) => session.paneId)
}

export interface PtySessionInfo {
  paneId: string
  kind: 'local' | 'ssh'
  cwd: string
  sshProfileId?: string
  sshTarget?: string
  sshLabel?: string
  outputCursor: number
}

function serializePtySession(session: Session): PtySessionInfo {
  return {
    paneId: session.paneId,
    kind: session.kind,
    cwd: session.cwd,
    sshProfileId: session.sshProfileId,
    sshTarget: session.sshTarget,
    sshLabel: session.sshLabel,
    outputCursor: session.outputEndCursor
  }
}

export function getPtySessionInfo(paneId: string): PtySessionInfo | null {
  const session = sessions.get(paneId)
  return session && !session.disposed ? serializePtySession(session) : null
}

export function verifyPtyTerminalToken(paneId: string, token: string): boolean {
  const session = sessions.get(paneId)
  if (!session || session.disposed || session.kind !== 'local' || !session.terminalMcpToken) {
    return false
  }
  const expected = Buffer.from(session.terminalMcpToken)
  const actual = Buffer.from(token)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function getActiveSshSessions(): PtySessionInfo[] {
  return Array.from(sessions.values())
    .filter(
      (session) => session.kind === 'ssh' && !session.disposed && !session.webContents.isDestroyed()
    )
    .map(serializePtySession)
}

export function readPtyOutput(
  paneId: string,
  cursor?: number,
  maxChars = 64 * 1024
): { data: string; cursor: number; truncated: boolean } {
  const session = sessions.get(paneId)
  if (!session || session.disposed) throw new Error(`终端面板不存在或已关闭：${paneId}`)
  const limit = Math.max(1, Math.min(256 * 1024, Math.round(maxChars)))
  const requested = Number.isFinite(cursor) ? Math.max(0, Math.round(cursor!)) : undefined
  const start =
    requested === undefined
      ? Math.max(session.outputStartCursor, session.outputEndCursor - limit)
      : Math.max(session.outputStartCursor, Math.min(requested, session.outputEndCursor))
  const available = session.outputEndCursor - start
  const length = Math.min(limit, available)
  const offset = start - session.outputStartCursor
  return {
    data: session.outputBuffer.slice(offset, offset + length),
    cursor: start + length,
    truncated: requested !== undefined && requested < session.outputStartCursor
  }
}

export function writeSshCommand(paneId: string, command: string): void {
  const session = sessions.get(paneId)
  if (!session || session.disposed || session.kind !== 'ssh') {
    throw new Error(`SSH 终端面板不存在或已关闭：${paneId}`)
  }
  session.pty.write(`${command}\r`)
}

/**
 * Best-effort check: does the pane's shell have any child process running
 * (i.e. is a command currently executing in it)? Used to warn before closing
 * a pane that's mid-task. node-pty's pid is the shell itself, so any child
 * means something is running.
 *
 * - Linux: /proc/<pid>/task/<pid>/children (space-separated child PIDs)
 * - macOS: `pgrep -P <pid>` (exit 0 ⇒ has children)
 * - Windows: CIM query for processes whose ParentProcessId is the shell
 */
export async function ptyHasRunningProcess(paneId: string): Promise<boolean> {
  const session = sessions.get(paneId)
  if (!session || session.disposed) return false
  const pid = session.pty.pid
  if (!pid) return false

  try {
    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      return raw.trim().length > 0
    }
    if (process.platform === 'darwin') {
      await execFileP('pgrep', ['-P', String(pid)], { timeout: 2000 })
      return true // pgrep exits 0 only when a match exists
    }
    if (isWindows) {
      const { stdout } = await execFileP(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Measure-Object).Count`
        ],
        { timeout: 5000, windowsHide: true }
      )
      return parseInt(stdout.trim(), 10) > 0
    }
  } catch {
    // pgrep exits 1 (no children), /proc race, powershell missing, timeout —
    // treat as "nothing running" so we never block close on a flaky probe.
  }
  return false
}

/**
 * lsof 在 LANG 未设置或非 UTF-8 时，会把非 ASCII 路径字节输出为
 * 字面 \\xHH 转义文字（如 \\xe8\\xb4\\xa2 而不是 财）。此函数将
 * 这些转义序列还原为 UTF-8 字符串。
 */
function decodeLsofEscapes(raw: string): string {
  return raw.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => {
    return String.fromCharCode(parseInt(hex, 16))
  })
}

/**
 * Best-effort lookup of the PTY shell's current working directory by PID.
 * Used to keep the toolbar in sync when the user `cd`s in the shell
 * (the toolbar's cwd prop is set at pane creation and stays stale otherwise).
 *
 * - Linux: read /proc/<pid>/cwd symlink (instant)
 * - macOS: `lsof -a -d cwd -p <pid> -Fn` parses one line of output
 * - Windows: no portable way without external tools — return null and let
 *   the renderer fall back to OSC 7 / the initial cwd.
 */
export async function getPtyCwd(paneId: string): Promise<string | null> {
  const session = sessions.get(paneId)
  if (!session || session.disposed) return null
  const pid = session.pty.pid
  if (!pid) return null

  try {
    if (process.platform === 'linux') {
      return readlinkSync(`/proc/${pid}/cwd`)
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileP('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
        encoding: 'utf8',
        timeout: 2000,
        // 打包后的 Electron 从 Finder/Dock 启动时没有 LANG 环境变量，
        // lsof 在 LANG 未设置或非 UTF-8 时会把非 ASCII 路径字节输出为
        // 字面 \\xHH 转义。显式传 C.UTF-8 确保 lsof 输出正确的 UTF-8 字符。
        env: { ...process.env, LANG: 'C.UTF-8' }
      })
      // -Fn output: lines like "p<pid>\nfcwd\nn/abs/path"
      const match = stdout.match(/^n(.+)$/m)
      if (!match) return null
      let path = match[1]
      // 兜底：即使设置了 LANG=C.UTF-8，极端情况下（如系统 locale 数据库
      // 损坏）lsof 仍可能输出 \\xHH 转义。decodeLsofEscapes 把这些字面
      // 转义还原为 UTF-8 字符串，防止乱码路径覆盖 OSC 7 提供的正确值。
      if (path.includes('\\x')) {
        path = decodeLsofEscapes(path)
      }
      return path
    }
  } catch {
    // PID gone, permissions denied, lsof missing — silently fall back
  }
  return null
}

/**
 * Returns the name of the repository's main working tree (the folder
 * containing the real `.git` directory), regardless of whether `cwd` is the
 * main repo or a linked worktree. Used by the new-worktree dialog so the
 * default project name is `<repo>-<branch>`, not `<currentFolder>-<branch>`
 * — which would compound (`repo-master-test`) when creating worktrees from
 * inside an existing worktree.
 *
 * Strategy: `git rev-parse --git-common-dir` returns the path to the shared
 * `.git` directory; its parent is the main working tree, and its basename
 * is the repo name. Returns null when cwd is not inside a git repo.
 */
export async function getRepoName(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { ...GIT_OPTS, cwd, timeout: 3000 }
    )
    const gitDir = stdout.trim()
    if (!gitDir) return null
    // Two shapes to handle:
    //   1) Normal repo:  D:/project/myrepo/.git → parent = myrepo, basename of
    //      gitDir is literally ".git" (or "" on some platforms after trim).
    //   2) Bare repo:    D:/project/myrepo.git  → no `.git` segment as parent;
    //      basename of gitDir is "myrepo.git" — strip the suffix.
    //
    // Detecting bare by "the basename of gitDir IS .git" (case 1) vs anything
    // else (case 2) avoids the old bug where `basename(parent)` returned a
    // generic parent folder like "repos" for a bare repo at `D:/repos/x.git`.
    const base = basename(gitDir)
    if (base === '.git') {
      const name = basename(dirname(gitDir))
      return name && name !== '.' ? name : null
    }
    return base.replace(/\.git$/, '') || null
  } catch {
    return null
  }
}

export async function getGitInfo(cwd: string): Promise<GitInfo> {
  try {
    const { stdout: inside } = await execFileP('git', ['rev-parse', '--is-inside-work-tree'], {
      ...GIT_OPTS,
      cwd,
      timeout: 3000
    })
    if (inside.trim() === 'true') {
      const { stdout: branch } = await execFileP('git', ['branch', '--show-current'], {
        ...GIT_OPTS,
        cwd,
        timeout: 3000
      })
      return { isRepo: true, branch: branch.trim() || null }
    }
  } catch {
    // not a git repo, or git not installed
  }
  return { isRepo: false, branch: null }
}

/**
 * Pick a sensible default remote: `origin` if it exists, otherwise the first
 * configured remote, otherwise '' (no remotes at all).
 */
export async function getDefaultRemote(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['remote'], { ...GIT_OPTS, cwd })
    const remotes = stdout
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
    if (remotes.includes('origin')) return 'origin'
    return remotes[0] ?? ''
  } catch {
    return ''
  }
}

export async function getGitBranches(cwd: string): Promise<BranchInfo[]> {
  const map = new Map<string, BranchInfo>()
  const remoteNames = new Set<string>()
  try {
    const { stdout } = await execFileP('git', ['remote'], { ...GIT_OPTS, cwd })
    for (const r of stdout
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean))
      remoteNames.add(r)
  } catch {
    // no remotes configured
  }

  try {
    const { stdout: local } = await execFileP('git', ['branch'], { ...GIT_OPTS, cwd })
    // `git branch` lines look like:
    //   `* master`            current branch
    //   `+ feature/foo`       checked out in another worktree
    //   `  develop`           neither
    // The first column is `*`, `+`, or space; tag `+` as a worktree-linked branch.
    for (const line of local.split('\n')) {
      const m = line.match(/^([+*]?)\s*(.+)$/)
      if (!m) continue
      const name = m[2].trim()
      if (!name || name.startsWith('(')) continue
      map.set(name, { name, local: true, remote: false, worktree: m[1] === '+' })
    }
  } catch {
    return []
  }

  try {
    const { stdout: remote } = await execFileP('git', ['branch', '-r'], { ...GIT_OPTS, cwd })
    for (const line of remote.split('\n')) {
      const raw = line.replace(/^\*?\s+/, '').trim()
      // Skip empty lines and any `<remote>/HEAD -> <remote>/master` alias line.
      if (!raw || raw.includes('HEAD ->') || raw.includes(' -> ')) continue
      // Split into `<remote>/<branch>`. The remote is the first path segment
      // that matches a configured remote name; the rest (which may itself
      // contain slashes, e.g. `feature/x`) is the branch.
      let remoteName = ''
      let short = raw
      const slash = raw.indexOf('/')
      if (slash > 0) {
        const candidate = raw.slice(0, slash)
        if (remoteNames.size === 0 || remoteNames.has(candidate)) {
          remoteName = candidate
          short = raw.slice(slash + 1)
        }
      }
      if (!short) continue
      const existing = map.get(short)
      if (existing) {
        // Local branch with the same name — annotate the existing row rather
        // than producing a duplicate. Prefer `origin` as the recorded remote.
        existing.remote = true
        if (!existing.remoteName || remoteName === 'origin') existing.remoteName = remoteName
      } else {
        // First remote to carry this name. A later `origin/<name>` line will
        // fall into the branch above and upgrade remoteName to `origin`.
        map.set(short, { name: short, local: false, remote: true, remoteName })
      }
    }
  } catch {
    // no remote, or git not available
  }

  const branches = Array.from(map.values())
  // Local-containing branches first (most likely target for checkout), then
  // remote-only. Alphabetical within each group.
  branches.sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return branches
}

// Stats must match the diff viewer (getGitDiff), which diffs vs HEAD —
// staged + unstaged. Plain `git diff --shortstat` only counts unstaged
// changes, so the badge undercounted once anything was `git add`ed. Same
// unborn-HEAD fallback as getGitDiff.
function parseShortstat(stdout: string): { added: number; deleted: number } {
  const added = (stdout.match(/(\d+) insertion/) || [])[1]
  const deleted = (stdout.match(/(\d+) deletion/) || [])[1]
  return { added: added ? parseInt(added) : 0, deleted: deleted ? parseInt(deleted) : 0 }
}

export async function getGitDiffStats(cwd: string): Promise<DiffStats> {
  try {
    const { stdout } = await execFileP('git', ['diff', 'HEAD', '--shortstat'], { ...GIT_OPTS, cwd })
    return parseShortstat(stdout)
  } catch {
    try {
      const { stdout } = await execFileP('git', ['diff', '--shortstat'], { ...GIT_OPTS, cwd })
      return parseShortstat(stdout)
    } catch {
      return { added: 0, deleted: 0 }
    }
  }
}

export async function checkoutGitBranch(
  cwd: string,
  branchName: string,
  isRemote?: boolean,
  remoteName?: string
): Promise<GitResult> {
  try {
    let args: string[]
    if (isRemote) {
      const remote = remoteName || (await getDefaultRemote(cwd)) || 'origin'
      args = ['checkout', '--track', `${remote}/${branchName}`]
    } else {
      args = ['checkout', branchName]
    }
    await execFileP('git', args, { ...GIT_OPTS, cwd })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

export async function gitHasUncommittedChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain'], { ...GIT_OPTS, cwd })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Stash tracked + staged changes (no `-u`: untracked files are left alone so
 * we don't sweep up build artifacts). Used by the "stash & switch" flow.
 */
export async function gitStash(cwd: string): Promise<GitResult> {
  try {
    await execFileP('git', ['stash', 'push', '-m', 'Gittim: 切换分支前自动暂存'], {
      ...GIT_OPTS,
      cwd
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Parse `git worktree list --porcelain`. The first record is always the main
 * working tree. Records are blank-line separated; keys: worktree/HEAD/branch/
 * bare/detached/locked.
 */
export async function getGitWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  try {
    const { stdout } = await execFileP('git', ['worktree', 'list', '--porcelain'], {
      ...GIT_OPTS,
      cwd
    })
    const out: WorktreeInfo[] = []
    let cur: Partial<WorktreeInfo> & { _seen?: boolean } = {}
    const flush = (): void => {
      if (cur.path) {
        out.push({
          path: cur.path,
          branch: cur.branch ?? null,
          head: cur.head ?? null,
          isMain: out.length === 0,
          detached: !!cur.detached,
          locked: !!cur.locked
        })
      }
      cur = {}
    }
    for (const line of stdout.split('\n')) {
      const l = line.trimEnd()
      if (l === '') {
        flush()
        continue
      }
      if (l.startsWith('worktree ')) cur.path = l.slice('worktree '.length)
      else if (l.startsWith('HEAD ')) cur.head = l.slice('HEAD '.length)
      else if (l.startsWith('branch '))
        cur.branch = l.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (l === 'detached') cur.detached = true
      else if (l.startsWith('locked')) cur.locked = true
    }
    flush()
    return out
  } catch {
    return []
  }
}

export async function gitRemoveWorktree(
  cwd: string,
  worktreePath: string,
  force?: boolean
): Promise<GitResult> {
  try {
    if (force) {
      // 强制路径:不走 `git worktree remove --force`,直接 fs.rm + prune。
      //
      // git 自带的 remove --force 在 Windows 上对 node_modules / IDE 索引锁定的
      // 文件经常以 "failed to delete" 失败 —— git 内部用一次性删除,EBUSY 直接
      // 抛错。fs.rm 的 maxRetries 在遇到 EBUSY/ENOTEMPTY/EPERM 时会按 retryDelay
      // 重试,大多数瞬时锁(VSCode/Trae 索引器、防病毒扫描)在几百毫秒内会释放。
      //
      // 删完后跑 `git worktree prune` 扫 `.git/worktrees/*` 把孤立条目清掉,
      // 状态等价于 `git worktree remove --force` 成功后的样子。
      await rm(worktreePath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      })
      await execFileP('git', ['worktree', 'prune'], { ...GIT_OPTS, cwd, timeout: 10_000 })
      return { success: true }
    }
    await execFileP('git', ['worktree', 'remove', worktreePath], {
      ...GIT_OPTS,
      cwd,
      timeout: 15_000
    })
    // git worktree remove 成功後目錄通常已刪除,但在 Windows 上偶發文件鎖導致
    // 目錄殘留(如防毒/索引器佔用);補一刀 rm 兜底,force 使其對不存在也無害。
    try {
      await rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // 目錄已不存在或其他原因無法刪除,不影響主流程
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * 算每个 commit 被哪些分支包含。
 *
 * `git branch --contains <hash>` 对单 commit 高效,但 batch N 个 commit 要跑 N 次
 * spawn(Windows cold-start 各 ~50ms 拉满)。这里换一个维度:对每个分支(M 通常远
 * 比 N 小)跑一次 `git rev-list <tip>` 拿到该分支的全部祖先,然后用 Set 做反向
 * 查表 —— O(M) spawn 而不是 O(N),且 M 个 rev-list 可以全并发。
 *
 * --max-count=10000 是为了避免在巨型仓库(linux/chromium 那种十万+ commit)单条
 * rev-list 输出几 MB 拖慢 IPC;GitLogViewer 一次 PAGE=50 + 累加分页,5000 已是
 * 用户能滚到的远古,10000 留 2x 余量 —— 真触到了限制(返回的 branches 没有覆
 * 盖该 hash),前端 fallback 表现就是"包含于"那一行少了几个分支,不影响主功能。
 */
export async function gitCommitBranches(
  cwd: string,
  hashes: string[]
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {}
  if (!hashes.length) return result
  for (const h of hashes) result[h] = []

  try {
    // 1) 一次性拿所有本地 + 远程分支的 tip。tag/HEAD 排除 —— 用户语义是"包含
    //    于哪些分支",ref decoration 已经显示 HEAD/tag。
    const { stdout: refsOut } = await execFileP(
      'git',
      ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/remotes/'],
      { ...GIT_OPTS, cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }
    )
    const branches: Array<{ name: string; tip: string }> = []
    for (const line of refsOut.split(/\r?\n/)) {
      if (!line) continue
      const sp = line.lastIndexOf(' ')
      if (sp <= 0) continue
      let refname = line.slice(0, sp)
      const tip = line.slice(sp + 1)
      // refs/heads/foo → foo; refs/remotes/origin/HEAD → origin/HEAD(后面会过滤)
      if (refname.startsWith('refs/heads/')) refname = refname.slice('refs/heads/'.length)
      else if (refname.startsWith('refs/remotes/')) refname = refname.slice('refs/remotes/'.length)
      // origin/HEAD 是个符号引用指向另一个分支的 tip,会跟那个分支重复 —— 跳过。
      if (refname === 'HEAD' || /\/HEAD$/.test(refname)) continue
      branches.push({ name: refname, tip })
    }

    const hashSet = new Set(hashes)

    // 2) 每个分支并发跑 rev-list,把命中的 hash 累到 result。allSettled 让单个
    //    rev-list 失败(比如 shallow clone 在某些分支报错)不影响其他分支。
    await Promise.allSettled(
      branches.map(async (b) => {
        try {
          const { stdout } = await execFileP('git', ['rev-list', '--max-count=10000', b.tip], {
            ...GIT_OPTS,
            cwd,
            timeout: 20_000,
            maxBuffer: 64 * 1024 * 1024
          })
          for (const h of stdout.split(/\r?\n/)) {
            if (h && hashSet.has(h)) {
              result[h].push(b.name)
            }
          }
        } catch {
          // 单个分支查询失败不影响其它 —— 静默继续
        }
      })
    )
  } catch {
    // for-each-ref 失败时返回全空 map —— 前端会把"包含于"那一行藏起来,主功能正常
  }
  return result
}

/**
 * Full working-tree diff vs HEAD (staged + unstaged) for the read-only viewer.
 * Falls back to `git diff` when there's no commit yet (unborn HEAD). Capped at
 * 10 MB so a huge diff can't blow up the IPC payload / renderer.
 */
export async function getGitDiff(cwd: string): Promise<DiffPayload> {
  const opts = { ...GIT_OPTS, cwd, maxBuffer: 10 * 1024 * 1024, timeout: 15_000 }
  try {
    const { stdout } = await execFileP('git', ['diff', 'HEAD'], opts)
    return { diff: stdout, truncated: false }
  } catch (err) {
    const e = err as { code?: string; stdout?: string }
    // maxBuffer exceeded still yields partial stdout — show what we have.
    if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && e.stdout) {
      return { diff: e.stdout, truncated: true }
    }
    // Unborn branch (no HEAD yet): fall back to the plain working-tree diff.
    try {
      const { stdout } = await execFileP('git', ['diff'], opts)
      return { diff: stdout, truncated: false }
    } catch {
      return { diff: '', truncated: false }
    }
  }
}

// ---------------------------------------------------------------------------
// Merge / rebase / cherry-pick / revert conflict state
// ---------------------------------------------------------------------------

// （MergeOpKind / ConflictedFile / MergeStatus 已迁移到 @shared/types。本文件
// 仍 re-export 给现有 import 用,见顶部 export type 块。）

/**
 * Resolve a git-internal path (e.g. `MERGE_HEAD`, `rebase-merge`) to an
 * absolute filesystem path. `git rev-parse --git-path` handles worktrees (where
 * the per-worktree state lives under `<main>/.git/worktrees/<name>/`) correctly,
 * whereas naively joining `<cwd>/.git/...` does not.
 */
async function gitInternalPath(cwd: string, internal: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--git-path', internal], {
      ...GIT_OPTS,
      cwd,
      timeout: 3000
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Two-char status from porcelain v2 → Chinese description. Same vocabulary as
 * Git's own documentation, just translated. Unrecognised codes fall back to
 * the raw code so the UI still shows something.
 */
function describeConflictStatus(xy: string): string {
  switch (xy) {
    case 'DD':
      return '双方删除'
    case 'AU':
      return '我方新增'
    case 'UD':
      return '对方删除'
    case 'UA':
      return '对方新增'
    case 'DU':
      return '我方删除'
    case 'AA':
      return '双方新增'
    case 'UU':
      return '双方修改'
    default:
      return xy
  }
}

/**
 * Detect any in-progress merge/rebase/cherry-pick/revert and list every
 * unmerged path. Strategy:
 *
 *   1. Probe the per-worktree state files (MERGE_HEAD, rebase-merge/,
 *      rebase-apply/, CHERRY_PICK_HEAD, REVERT_HEAD) via `git rev-parse
 *      --git-path` so worktrees work correctly.
 *   2. Decode the "target" of the operation from the most useful source for
 *      each kind — MERGE_MSG's first line for merge, head-name for rebase,
 *      the head hash for cherry-pick/revert.
 *   3. Parse `git status -z --porcelain=v2 -u` for `u ` rows (unmerged) — the
 *      -z form is NUL-separated, so paths with spaces / quotes / newlines
 *      pass through intact.
 */
export async function getMergeStatus(cwd: string): Promise<MergeStatus> {
  const empty: MergeStatus = { inProgress: null, target: null, onto: null, conflicts: [] }

  // Cheap up-front check — if git can't even tell us this is a repo, bail.
  try {
    const { stdout: inside } = await execFileP('git', ['rev-parse', '--is-inside-work-tree'], {
      ...GIT_OPTS,
      cwd,
      timeout: 3000
    })
    if (inside.trim() !== 'true') return empty
  } catch {
    return empty
  }

  // --- detect operation kind --------------------------------------------
  const [mergeHead, rebaseMerge, rebaseApply, cherryHead, revertHead] = await Promise.all([
    gitInternalPath(cwd, 'MERGE_HEAD'),
    gitInternalPath(cwd, 'rebase-merge'),
    gitInternalPath(cwd, 'rebase-apply'),
    gitInternalPath(cwd, 'CHERRY_PICK_HEAD'),
    gitInternalPath(cwd, 'REVERT_HEAD')
  ])

  let kind: MergeOpKind | null = null
  let target: string | null = null
  let onto: string | null = null

  const readFirstLine = (p: string | null): string | null => {
    if (!p) return null
    try {
      const raw = readFileSync(p, 'utf8')
      const first = raw.split(/\r?\n/, 1)[0]
      return first.trim() || null
    } catch {
      return null
    }
  }

  if (mergeHead && existsSync(mergeHead)) {
    kind = 'merge'
    // MERGE_MSG first line is conventionally `Merge branch 'feature/x'` or
    // `Merge remote-tracking branch 'origin/main'`. Strip the boilerplate.
    const mergeMsg = await gitInternalPath(cwd, 'MERGE_MSG')
    const firstLine = readFirstLine(mergeMsg)
    if (firstLine) {
      const m = firstLine.match(/^Merge (?:remote-tracking )?branch '([^']+)'/)
      target = m ? m[1] : firstLine
    } else {
      target = readFirstLine(mergeHead) // fallback: the SHA
    }
  } else if (rebaseMerge && existsSync(rebaseMerge)) {
    kind = 'rebase'
    target = readFirstLine(`${rebaseMerge}/head-name`)?.replace(/^refs\/heads\//, '') || null
    onto = readFirstLine(`${rebaseMerge}/onto`)
    if (onto) onto = onto.slice(0, 7)
  } else if (rebaseApply && existsSync(rebaseApply)) {
    kind = 'rebase'
    target = readFirstLine(`${rebaseApply}/head-name`)?.replace(/^refs\/heads\//, '') || null
    onto = readFirstLine(`${rebaseApply}/onto`)
    if (onto) onto = onto.slice(0, 7)
  } else if (cherryHead && existsSync(cherryHead)) {
    kind = 'cherry-pick'
    const sha = readFirstLine(cherryHead)
    target = sha ? sha.slice(0, 7) : null
  } else if (revertHead && existsSync(revertHead)) {
    kind = 'revert'
    const sha = readFirstLine(revertHead)
    target = sha ? sha.slice(0, 7) : null
  }

  // --- enumerate unmerged paths ----------------------------------------
  // `git status -z --porcelain=v2 -u` rows are NUL-terminated. Format spec at
  // https://git-scm.com/docs/git-status#_porcelain_format_version_2 — `u` rows
  // start with `u ` and the path is the 11th whitespace-separated token.
  const conflicts: ConflictedFile[] = []
  try {
    const { stdout } = await execFileP('git', ['status', '-z', '--porcelain=v2', '-u'], {
      ...GIT_OPTS,
      cwd,
      maxBuffer: 4 * 1024 * 1024
    })
    // NUL splits records. The last "record" after a trailing NUL is empty —
    // filter it out. Rename/copy entries (type `2`) span TWO NUL chunks (new
    // path, then orig path); we skip them since conflicts can't be renames.
    const records = stdout.split('\0').filter(Boolean)
    for (const rec of records) {
      if (!rec.startsWith('u ')) continue
      // Layout: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`.
      // 不能用 `split(' ').slice(10).join(' ')` —— path 中的连续空格(Windows
      // 风格 `My  Documents/foo.txt`)、tab、控制字符都会被 split+join 压成单
      // 空格,后续 `git checkout --ours -- <path>` 就找不到文件了。改为定位
      // 第 10 个空格的位置(`u` 之后第 9 个字段结束的空格),从那之后整段当
      // path —— 字面保留任何字符。
      let pos = -1
      for (let i = 0, count = 0; i < rec.length; i++) {
        if (rec[i] === ' ' && ++count === 10) {
          pos = i
          break
        }
      }
      if (pos < 0) continue
      const path = rec.slice(pos + 1)
      if (!path) continue
      // XY 是 `u ` 之后固定 2 字符。
      const xy = rec.slice(2, 4)
      conflicts.push({ path, status: xy, description: describeConflictStatus(xy) })
    }
  } catch {
    // status failed for some reason; report op kind without file list.
  }

  if (!kind && !conflicts.length) return empty
  return { inProgress: kind, target, onto, conflicts }
}

/**
 * Resolve a conflicted file by picking one side and staging it.
 *   ours   = the branch we were on when the operation started
 *   theirs = the incoming branch / commit
 *
 * Note: during a rebase, "ours" and "theirs" are swapped relative to a merge —
 * `--ours` in rebase means the commit being replayed (the branch you rebased),
 * NOT the branch you started on. We pass the flag through verbatim and the UI
 * labels reflect the operation kind.
 */
export async function resolveConflictBySide(
  cwd: string,
  file: string,
  side: 'ours' | 'theirs'
): Promise<GitResult> {
  try {
    await execFileP('git', ['checkout', `--${side}`, '--', file], { ...GIT_OPTS, cwd })
    await execFileP('git', ['add', '--', file], { ...GIT_OPTS, cwd })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Mark a conflicted file as resolved (user edited it externally — e.g. in
 * their IDE — and wants Gittim to `git add` it). No checkout, just add.
 */
export async function markConflictResolved(cwd: string, file: string): Promise<GitResult> {
  try {
    await execFileP('git', ['add', '--', file], { ...GIT_OPTS, cwd })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/** 读取 Git index 的 base/ours/theirs 三个 stage，供可视化三方合并器使用。 */
export async function getConflictVersions(cwd: string, file: string): Promise<ConflictVersions> {
  const readStage = async (stage: 1 | 2 | 3): Promise<string | null> => {
    try {
      const { stdout } = await execFileP('git', ['show', `:${stage}:${file}`], {
        ...GIT_OPTS,
        cwd,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000
      })
      return stdout.includes('\0') ? null : stdout
    } catch {
      return null
    }
  }
  const [base, ours, theirs] = await Promise.all([readStage(1), readStage(2), readStage(3)])
  let working: string | null = null
  try {
    working = await readFile(resolve(cwd, file), 'utf8')
    if (working.includes('\0')) working = null
  } catch {
    // 删除冲突可能没有工作区文件。
  }
  return { base, ours, theirs, working }
}

/** 保存人工合并结果并 git add。路径必须留在当前工作树内。 */
export async function saveConflictResolution(
  cwd: string,
  file: string,
  content: string
): Promise<GitResult> {
  const root = resolve(cwd)
  const target = resolve(root, file)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || rel.includes('\0')) {
    return { success: false, error: '无效的冲突文件路径' }
  }
  try {
    await writeFile(target, content, 'utf8')
    await execFileP('git', ['add', '--', file], { ...GIT_OPTS, cwd })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Abort the in-progress operation. The caller's `kind` is normally derived
 * from the most recent `getMergeStatus()` call; we trust it rather than
 * re-detecting, so a stale UI state doesn't drive the wrong git command.
 */
export async function abortMergeOp(cwd: string, kind: MergeOpKind): Promise<GitResult> {
  const subCmd =
    kind === 'merge'
      ? ['merge', '--abort']
      : kind === 'rebase'
        ? ['rebase', '--abort']
        : kind === 'cherry-pick'
          ? ['cherry-pick', '--abort']
          : ['revert', '--abort']
  try {
    await execFileP('git', subCmd, { ...GIT_OPTS, cwd, timeout: 15_000 })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Continue the in-progress operation. Git refuses if conflicts remain — we
 * surface the error verbatim so the user sees which path still has markers.
 *
 * `--no-edit` keeps Git from popping an editor in the middle of the IPC call
 * (we have no TTY here). For merge/cherry-pick/revert that means "reuse the
 * default commit message"; for rebase --continue it's a no-op (still safe).
 */
export async function continueMergeOp(cwd: string, kind: MergeOpKind): Promise<GitResult> {
  const subCmd =
    kind === 'merge'
      ? ['merge', '--continue', '--no-edit']
      : kind === 'rebase'
        ? ['rebase', '--continue']
        : kind === 'cherry-pick'
          ? ['cherry-pick', '--continue', '--no-edit']
          : ['revert', '--continue', '--no-edit']
  // For rebase, GIT_EDITOR=true makes any editor invocation succeed silently
  // (rebase --continue may want to amend the message on each step). Same trick
  // git's own `--no-edit` flag uses internally for the other ops.
  const env = { ...process.env, GIT_EDITOR: 'true' }
  try {
    await execFileP('git', subCmd, { ...GIT_OPTS, cwd, timeout: 30_000, env })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Full unified diff of one path against HEAD. Used by the conflict panel's
 * inline preview so the user can eyeball the marker blocks without opening
 * their editor. Includes the leading `diff --git` header so diff2html can
 * parse it.
 */
/**
 * 拉取某 ref 下的文件内容，供 DiffViewer 做整文件级语法高亮。
 *
 * - `ref === null`：读工作区文件
 * - `ref` 是 hash / 分支 / 'HEAD'：走 `git show <ref>:<path>`
 *
 * 超过 2 MB、文件不存在、git show 失败、内容含 NUL（二进制）一律返回 null，
 * 让前端 fallback 到无高亮的纯文本渲染。
 */
// git ref 名允许字母数字 + / . _ - ^ ~ @,且不能以 - 开头(否则会被 git 当 flag
// 解析)。`HEAD^` / `abc123^` / `feat/x` / `tags/v1.0.0` 都合法。`git show <ref>:
// <path>` 不支持 `--` 分隔(整个 revision-shaped 实参是一个 token),所以必须
// 用白名单兜底。出现非法字符直接 reject —— 比静默截断更安全。
function isSafeGitRef(ref: string): boolean {
  if (!ref || ref.startsWith('-')) return false
  // 显式允许 ref 中可能合法出现的字符
  return /^[A-Za-z0-9_./^~@-]+$/.test(ref)
}

export async function gitShowFile(
  cwd: string,
  ref: string | null,
  path: string
): Promise<string | null> {
  if (!path) return null
  const MAX = 2 * 1024 * 1024
  try {
    let content: string
    if (ref === null) {
      const full = join(cwd, path)
      let size: number
      try {
        size = statSync(full).size
      } catch {
        return null
      }
      if (size > MAX) return null
      content = await readFile(full, 'utf-8')
    } else {
      if (!isSafeGitRef(ref)) return null
      const { stdout } = await execFileP('git', ['show', `${ref}:${path}`], {
        ...GIT_OPTS,
        cwd,
        maxBuffer: MAX,
        timeout: 5000
      })
      content = stdout
    }
    if (content.includes('\0')) return null
    return content
  } catch {
    return null
  }
}

export async function getFileDiff(cwd: string, file: string): Promise<DiffPayload> {
  const opts = { ...GIT_OPTS, cwd, maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }
  try {
    const { stdout } = await execFileP('git', ['diff', '--', file], opts)
    return { diff: stdout, truncated: false }
  } catch (err) {
    const e = err as { code?: string; stdout?: string }
    if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && e.stdout) {
      return { diff: e.stdout, truncated: true }
    }
    return { diff: '', truncated: false }
  }
}

// ---------------------------------------------------------------------------
// Commit history (git log + show)
// ---------------------------------------------------------------------------

// CommitInfo / CommitDetail 已迁移到 @shared/types,见顶部 re-export。

// ASCII Unit Separator (0x1F) between fields; Record Separator (0x1E) between
// commits. Both are extremely rare in real commit messages and immune to
// quoting issues from arbitrary author names / subjects.
const LOG_FIELD_SEP = '\x1f'
const LOG_RECORD_SEP = '\x1e'
const LOG_FORMAT = ['%H', '%h', '%an', '%ae', '%aI', '%P', '%D', '%s'].join(LOG_FIELD_SEP)

function parseRefs(raw: string): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * List commits reachable from HEAD (or from every ref when `all` is true),
 * paginated via `--skip` + `--max-count`. Each commit lands on a single
 * record separated by 0x1E; fields inside are separated by 0x1F so commit
 * subjects with commas/quotes/newlines remain intact.
 *
 * `--no-decorate` is omitted on purpose so `%D` returns the ref decorations
 * (HEAD pointer, branch/tag names) we render as chips in the UI.
 */
export async function getCommitLog(cwd: string, opts: CommitLogOpts): Promise<CommitInfo[]> {
  const args = [
    'log',
    `--pretty=format:${LOG_RECORD_SEP}${LOG_FORMAT}`,
    // 默认 50 条 —— 大仓库一次 200 太重(包括解析 parents/refs + 渲染),
    // 滚动加载更顺。caller 可以传 limit 覆盖。
    `--max-count=${Math.max(1, Math.min(opts.limit ?? 50, 1000))}`,
    `--skip=${Math.max(0, opts.skip ?? 0)}`
  ]
  if (opts.grep) {
    args.push('-i', `--grep=${opts.grep}`)
  }
  if (opts.author) {
    // --author also accepts a regex; -i is shared with --grep above.
    if (!opts.grep) args.push('-i')
    args.push(`--author=${opts.author}`)
  }
  // Refs that look like flags can't be valid git refs, but reject them
  // defensively so a malformed UI state can't slip a flag past argv.
  if (opts.ref && !opts.ref.startsWith('-')) {
    args.push(opts.ref)
  }
  try {
    const { stdout } = await execFileP('git', args, {
      ...GIT_OPTS,
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000
    })
    const records = stdout.split(LOG_RECORD_SEP).filter((r) => r.length > 0)
    const out: CommitInfo[] = []
    for (const rec of records) {
      const fields = rec.split(LOG_FIELD_SEP)
      if (fields.length < 8) continue
      const [hash, shortHash, author, email, date, parents, refs, subject] = fields
      out.push({
        hash,
        shortHash,
        author,
        email,
        date,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        refs: parseRefs(refs),
        subject: (subject || '').replace(/\r?\n$/, '')
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Full detail for one commit: same metadata as the list row, plus the body
 * (lines after the subject) and the unified patch. Capped at 10 MB so a
 * monster commit (vendored dependency, generated lockfile) can't pin the
 * IPC channel.
 */
export async function getCommitDetail(cwd: string, hash: string): Promise<CommitDetail | null> {
  // Sanitize: only accept hash-like input. Branch names / refs could end up
  // here from an out-of-date UI; require hex so we never feed an attacker-
  // controlled --flag-shaped string into `git show`.
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) return null
  try {
    const headArgs = ['log', '-1', `--pretty=format:${LOG_FORMAT}${LOG_FIELD_SEP}%b`, hash]
    const { stdout: headOut } = await execFileP('git', headArgs, {
      ...GIT_OPTS,
      cwd,
      timeout: 5_000
    })
    const fields = headOut.split(LOG_FIELD_SEP)
    if (fields.length < 9) return null
    const [h, shortHash, author, email, date, parents, refs, subject, ...bodyParts] = fields
    const body = bodyParts.join(LOG_FIELD_SEP).replace(/\r?\n$/, '')

    let diff = ''
    let truncated = false
    try {
      const { stdout } = await execFileP('git', ['show', '--format=', '--patch', hash], {
        ...GIT_OPTS,
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 15_000
      })
      diff = stdout
    } catch (err) {
      const e = err as { code?: string; stdout?: string }
      if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && e.stdout) {
        diff = e.stdout
        truncated = true
      }
    }

    return {
      hash: h,
      shortHash,
      author,
      email,
      date,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      refs: parseRefs(refs),
      subject: (subject || '').replace(/\r?\n$/, ''),
      body,
      diff,
      truncated
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Branch operations (merge / rebase / push / pull / delete)
// ---------------------------------------------------------------------------

/**
 * `GIT_EDITOR=true` makes any editor invocation succeed silently so merge
 * commit messages, rebase todo lists, etc. don't block on an absent TTY.
 * Shared env for every long-running ref-mutating command below.
 */
function nonInteractiveEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_EDITOR: 'true' }
}

/** Reject obvious flag-shaped strings before passing user-picked refs to git. */
function isSafeRef(ref: string): boolean {
  return !!ref && !ref.startsWith('-')
}

/**
 * Merge `ref` into the current branch (`git merge --no-edit <ref>`). Conflicts
 * leave the worktree in a merging state — the PaneToolbar refresh that follows
 * picks that up via getMergeStatus and the badge appears automatically.
 */
export async function gitMerge(cwd: string, ref: string): Promise<GitResult> {
  if (!isSafeRef(ref)) return { success: false, error: '无效的分支引用' }
  try {
    await execFileP('git', ['merge', '--no-edit', ref], {
      ...GIT_OPTS,
      cwd,
      timeout: 60_000,
      env: nonInteractiveEnv()
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Rebase the current branch onto `ref`. Same conflict-recovery story as
 * gitMerge — leaves a rebase-in-progress state on conflict.
 */
export async function gitRebase(cwd: string, ref: string): Promise<GitResult> {
  if (!isSafeRef(ref)) return { success: false, error: '无效的分支引用' }
  try {
    await execFileP('git', ['rebase', ref], {
      ...GIT_OPTS,
      cwd,
      timeout: 60_000,
      env: nonInteractiveEnv()
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/** Create and check out a local branch from an arbitrary local/remote ref. */
export async function gitCreateBranch(
  cwd: string,
  name: string,
  startRef: string
): Promise<GitResult> {
  if (!isSafeRef(name) || !isSafeRef(startRef)) {
    return { success: false, error: '无效的分支名或起点' }
  }
  try {
    // 让 Git 自己做完整的 ref 格式校验（重复斜杠、..、@{ 等边界）。
    await execFileP('git', ['check-ref-format', '--branch', name], { ...GIT_OPTS, cwd })
    await execFileP('git', ['checkout', '-b', name, startRef], {
      ...GIT_OPTS,
      cwd,
      timeout: 30_000
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Push a branch to its default remote. Uses `-u` unconditionally — git accepts
 * it as a no-op if the upstream is already set. No `--force` exposure: a
 * dedicated UI affordance is safer than smuggling it through a context-menu
 * "推送" entry.
 */
export async function gitPush(cwd: string, branch: string): Promise<GitResult> {
  if (!isSafeRef(branch)) return { success: false, error: '无效的分支名' }
  try {
    const remote = await getDefaultRemote(cwd)
    if (!remote) return { success: false, error: '仓库未配置远程' }
    await execFileP('git', ['push', '-u', remote, branch], {
      ...GIT_OPTS,
      cwd,
      timeout: 60_000
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Fast-forward only `git pull` on the current branch. We never auto-merge or
 * auto-rebase a divergent pull — the user should make that call explicitly via
 * the merge/rebase entries.
 */
export async function gitPull(cwd: string): Promise<GitResult> {
  try {
    await execFileP('git', ['pull', '--ff-only'], {
      ...GIT_OPTS,
      cwd,
      timeout: 60_000,
      env: nonInteractiveEnv()
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Delete a local branch. Tries `-d` first (refuses unmerged); the caller can
 * retry with `force=true` (`-D`) after confirming.
 */
export async function gitDeleteBranch(
  cwd: string,
  branch: string,
  force?: boolean
): Promise<GitResult> {
  if (!isSafeRef(branch)) return { success: false, error: '无效的分支名' }
  try {
    await execFileP('git', ['branch', force ? '-D' : '-d', branch], { ...GIT_OPTS, cwd })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

export async function gitAddWorktree(
  cwd: string,
  opts: WorktreeAddOpts
): Promise<GitResultWithWarning> {
  try {
    // 先更新远程引用，确保 fromBranch 对应的远程分支已拉取到本地。
    // fetch 失败（无网络等）不阻塞 —— 用户可能已有本地分支或离线工作。
    try {
      await execFileP('git', ['fetch', '--prune'], {
        ...GIT_OPTS,
        cwd,
        timeout: 30_000
      })
    } catch {
      // 静默忽略，后续 git worktree add 如果失败会报具体错误
    }

    const args = ['worktree', 'add']
    if (opts.newBranch) args.push('-b', opts.newBranch)
    args.push(opts.path)
    if (opts.fromBranch) args.push(opts.fromBranch)
    await execFileP('git', args, { ...GIT_OPTS, cwd, timeout: 15_000 })

    if (opts.newBranch) {
      const remote = await getDefaultRemote(cwd)
      if (!remote) {
        return {
          success: true,
          warning: `分支 "${opts.newBranch}" 已创建（仓库未配置远程，已跳过推送）`
        }
      }
      try {
        await execFileP('git', ['push', '-u', remote, opts.newBranch], {
          ...GIT_OPTS,
          cwd: opts.path,
          timeout: 15_000
        })
      } catch {
        return {
          success: true,
          warning: `分支 "${opts.newBranch}" 已创建，但推送失败，请手动执行 git push -u ${remote} "${opts.newBranch}"`
        }
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}
