import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { DiffPayload, DiffStats } from '@shared/types'

const execFileP = promisify(execFile)
const GIT_OPTS = { encoding: 'utf8' as const, timeout: 10_000, windowsHide: true }
const MAX_DIFF_BYTES = 10 * 1024 * 1024

interface DiffContext {
  baseArgs: string[]
  env?: NodeJS.ProcessEnv
  fallbackWithoutHead: boolean
  dispose: () => Promise<void>
}

function emptyDispose(): Promise<void> {
  return Promise.resolve()
}

async function createDiffContext(cwd: string): Promise<DiffContext> {
  const { stdout: untrackedPaths } = await execFileP(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { ...GIT_OPTS, cwd, maxBuffer: MAX_DIFF_BYTES }
  )

  if (!untrackedPaths) {
    return {
      baseArgs: ['HEAD'],
      fallbackWithoutHead: true,
      dispose: emptyDispose
    }
  }

  const token = randomBytes(12).toString('hex')
  const indexPath = join(tmpdir(), `troupe-git-diff-${token}.index`)
  const pathspecPath = join(tmpdir(), `troupe-git-diff-${token}.paths`)
  const env = { ...process.env, GIT_INDEX_FILE: indexPath }
  const dispose = async (): Promise<void> => {
    await Promise.allSettled([rm(indexPath, { force: true }), rm(pathspecPath, { force: true })])
  }

  try {
    await writeFile(pathspecPath, untrackedPaths)

    let hasHead = true
    try {
      await execFileP('git', ['read-tree', 'HEAD'], { ...GIT_OPTS, cwd, env })
    } catch {
      hasHead = false
      await execFileP('git', ['read-tree', '--empty'], { ...GIT_OPTS, cwd, env })
    }

    // The alternate index starts at HEAD and exists only for this request.
    // Intent-to-add makes untracked files visible to `git diff` without
    // touching the user's real staging area or copying file contents.
    await execFileP(
      'git',
      [
        '--literal-pathspecs',
        'add',
        '--intent-to-add',
        `--pathspec-from-file=${pathspecPath}`,
        '--pathspec-file-nul'
      ],
      { ...GIT_OPTS, cwd, env, maxBuffer: MAX_DIFF_BYTES }
    )

    return {
      baseArgs: hasHead ? ['HEAD'] : [],
      env,
      fallbackWithoutHead: false,
      dispose
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

function isMaxBufferError(error: unknown): error is { code: string; stdout?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  )
}

async function runWorkingTreeDiff(
  cwd: string,
  extraArgs: string[],
  maxBuffer: number,
  timeout: number
): Promise<string> {
  const context = await createDiffContext(cwd)
  const opts = {
    ...GIT_OPTS,
    cwd,
    env: context.env,
    maxBuffer,
    timeout
  }

  try {
    try {
      const { stdout } = await execFileP(
        'git',
        ['-c', 'core.quotePath=false', 'diff', ...context.baseArgs, ...extraArgs],
        opts
      )
      return stdout
    } catch (error) {
      if (isMaxBufferError(error) || !context.fallbackWithoutHead) throw error

      // No temporary index means there were no untracked files. In an unborn
      // repository HEAD is invalid, so compare the working tree to the index.
      const { stdout } = await execFileP(
        'git',
        ['-c', 'core.quotePath=false', 'diff', ...extraArgs],
        opts
      )
      return stdout
    }
  } finally {
    await context.dispose()
  }
}

function parseShortstat(stdout: string): DiffStats {
  const files = (stdout.match(/(\d+) files? changed/) || [])[1]
  const added = (stdout.match(/(\d+) insertions?\(\+\)/) || [])[1]
  const deleted = (stdout.match(/(\d+) deletions?\(-\)/) || [])[1]
  return {
    files: files ? parseInt(files) : 0,
    added: added ? parseInt(added) : 0,
    deleted: deleted ? parseInt(deleted) : 0
  }
}

export async function getWorkingTreeDiffStats(cwd: string): Promise<DiffStats> {
  try {
    const stdout = await runWorkingTreeDiff(cwd, ['--shortstat'], MAX_DIFF_BYTES, 10_000)
    return parseShortstat(stdout)
  } catch {
    return { files: 0, added: 0, deleted: 0 }
  }
}

export async function getWorkingTreeDiff(cwd: string): Promise<DiffPayload> {
  try {
    const diff = await runWorkingTreeDiff(cwd, [], MAX_DIFF_BYTES, 15_000)
    return { diff, truncated: false }
  } catch (error) {
    if (isMaxBufferError(error) && error.stdout) {
      return { diff: error.stdout, truncated: true }
    }
    return { diff: '', truncated: false }
  }
}
