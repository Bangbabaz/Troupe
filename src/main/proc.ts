import { execFile } from 'child_process'
import { promisify } from 'util'
import { getShellRuntime } from './shell-runtime'

const execFileP = promisify(execFile)
const isWindows = process.platform === 'win32'

/**
 * Kill a process and every descendant it spawned. `pty.kill()` alone only
 * signals the shell, so long-running grandchildren (dev servers, watchers,
 * `npm`→`node`→`vite`/`esbuild`/`nx-executor`) get reparented and linger
 * after the task is stopped.
 *
 * Both platforms use the same three-step shape: snapshot the descendant
 * tree, kill from the root, then SIGKILL/taskkill each snapshotted PID
 * individually. The snapshot has to happen *before* the root dies — once
 * it's gone, detached grandchildren (nx fork.js with setsid, pnpm/bash
 * job-control PGs on POSIX; anything detached on Windows) get reparented
 * to PID 1 / the system, and the parent chain that lets `process.kill(-pg)`
 * or `taskkill /T` find them is lost forever.
 *
 * Shared by shell.ts (pane PTYs) and tasks.ts (background tasks) so the
 * tree-reaping behaviour can't drift between the two.
 *
 * Returns a promise that resolves once the kill commands have been issued.
 * Callers may fire-and-forget; awaiting is only useful when you need a
 * (best-effort) guarantee the descendants were signalled.
 */
export async function killProcessTree(pid: number | undefined | null): Promise<void> {
  if (!pid) return
  if (isWindows) {
    return killTreeWindows(pid)
  }

  // POSIX：进程组信号只能杀"乖"的后代。nx 的 tasks-runner/fork.js 用
  // detached:true 自带 setsid，pnpm/bash job control 也会把命令塞进新 PG，
  // 这些后代收不到 -pid 信号。对齐 Windows 分支：先快照、再发 SIGTERM、
  // 升级 SIGKILL 时再快照一次抓住缓刑期内新派生的孙子。
  const initial = await snapshotDescendantsPosix(pid)

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // 进程组已经没了
  }
  for (const d of initial) {
    try {
      process.kill(d, 'SIGTERM')
    } catch {
      // 已退出
    }
  }

  setTimeout(async () => {
    const late = await snapshotDescendantsPosix(pid)
    const all = new Set<number>([...initial, ...late])

    // 进程组兜底（带 signal 0 探测，避免 PID 复用打错人）
    try {
      process.kill(-pid, 0)
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // group exited between the probe and the kill
      }
    } catch {
      // group already exited; nothing to escalate
    }

    for (const d of all) {
      try {
        process.kill(d, 0)
        try {
          process.kill(d, 'SIGKILL')
        } catch {
          // descendant exited between probe and kill
        }
      } catch {
        // descendant already exited
      }
    }
  }, 2000).unref()
}

/**
 * Walk the live process table once via CIM and return every descendant PID
 * of `rootPid` (children, grandchildren, …). Snapshotting the whole graph
 * in one query is dramatically faster than recursive PowerShell calls and
 * — critically — sees the tree as it currently is, *before* we start
 * killing anything. Once a parent dies the OS reparents its survivors to
 * the system process and that ancestry is lost forever.
 */
async function snapshotDescendantsWindows(rootPid: number): Promise<number[]> {
  const shell = getShellRuntime()
  if (shell.kind !== 'powershell') return []
  try {
    const { stdout } = await execFileP(
      shell.executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // CSV: "ProcessId","ParentProcessId" rows. ConvertTo-Csv is more
        // reliable to parse than Format-Table (which word-wraps).
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation'
      ],
      { timeout: 5_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    )
    const children = new Map<number, number[]>()
    // skip the CSV header line
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const m = line.match(/^"?(\d+)"?,"?(\d+)"?$/)
      if (!m) continue
      const child = parseInt(m[1], 10)
      const parent = parseInt(m[2], 10)
      if (!Number.isFinite(child) || !Number.isFinite(parent)) continue
      let arr = children.get(parent)
      if (!arr) {
        arr = []
        children.set(parent, arr)
      }
      arr.push(child)
    }
    const result: number[] = []
    const seen = new Set<number>([rootPid])
    const queue: number[] = [rootPid]
    while (queue.length) {
      const cur = queue.shift()!
      const kids = children.get(cur)
      if (!kids) continue
      for (const k of kids) {
        if (seen.has(k)) continue
        seen.add(k)
        result.push(k)
        queue.push(k)
      }
    }
    return result
  } catch {
    return []
  }
}

async function killTreeWindows(pid: number): Promise<void> {
  // 1) Snapshot the descendant tree before issuing any kill, otherwise
  //    reparented grandchildren (especially Nx/webpack/vite workers that
  //    detach themselves from the shell) become unreachable.
  const descendants = await snapshotDescendantsWindows(pid)

  // 2) Best-effort tree kill from the root. /T walks the LIVE parent chain
  //    so it catches anything still connected.
  await new Promise<void>((resolve) => {
    execFile(
      'taskkill',
      ['/pid', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 5_000 },
      () => resolve()
    )
  })

  // 3) Kill each snapshotted descendant individually. If /T already reaped
  //    them the second taskkill is a harmless no-op (exits non-zero, which
  //    we ignore). This is what actually catches detached workers.
  if (descendants.length) {
    await Promise.all(
      descendants.map(
        (p) =>
          new Promise<void>((resolve) => {
            execFile(
              'taskkill',
              ['/pid', String(p), '/F'],
              { windowsHide: true, timeout: 5_000 },
              () => resolve()
            )
          })
      )
    )
  }
}

/**
 * POSIX 版的进程后代快照：一次 `ps -axo pid=,ppid=` 拉整张进程表（末尾 `=`
 * 抑制表头，BSD/GNU ps 都支持），BFS 出全部后代。比递归 pgrep -P 快，更关键的
 * 是必须在 SIGKILL 前调用一次 —— 一旦 root 死了 setsid 出去的孙子会被 init
 * (PID 1) 收养，ppid 链就断了。
 */
async function snapshotDescendantsPosix(rootPid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid='], {
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024
    })
    const children = new Map<number, number[]>()
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (!m) continue
      const child = parseInt(m[1], 10)
      const parent = parseInt(m[2], 10)
      if (!Number.isFinite(child) || !Number.isFinite(parent)) continue
      let arr = children.get(parent)
      if (!arr) {
        arr = []
        children.set(parent, arr)
      }
      arr.push(child)
    }
    const result: number[] = []
    const seen = new Set<number>([rootPid])
    const queue: number[] = [rootPid]
    while (queue.length) {
      const cur = queue.shift()!
      const kids = children.get(cur)
      if (!kids) continue
      for (const k of kids) {
        if (seen.has(k)) continue
        seen.add(k)
        result.push(k)
        queue.push(k)
      }
    }
    return result
  } catch {
    return []
  }
}
