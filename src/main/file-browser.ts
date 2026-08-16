import { execFile } from 'child_process'
import { watch, type FSWatcher } from 'fs'
import { lstat, readFile, readdir, realpath, stat } from 'fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { FileBrowserEntry, FileBrowserPreview, FileGitStatus } from '@shared/types'

const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_ENTRIES = 50_000
const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024
const MAX_TEXT_PREVIEW_SIZE = 512 * 1024
const MAX_IMAGE_PREVIEW_SIZE = 8 * 1024 * 1024
const SEARCH_SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])

const IMAGE_MIME: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

const EXTERNAL_MIME: Record<string, string> = {
  '.aac': 'audio/aac',
  '.avi': 'video/x-msvideo',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.wav': 'audio/wav',
  '.webm': 'video/webm'
}

interface WatchRecord {
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
  root: string
  changed: Set<string>
  notify: (root: string, paths: string[]) => void
}

const watchers = new Map<string, WatchRecord>()

function toUiPath(path: string): string {
  return path.split(sep).join('/')
}

export function shouldNotifyFileChange(filename: string | Buffer | null): boolean {
  if (!filename) return false
  const path = toUiPath(filename.toString())
  if (!path) return false
  return !path.split(/[\\/]/).some((segment) => segment.toLocaleLowerCase() === '.git')
}

export function isPathInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function canonicalRoot(root: string): Promise<string> {
  if (!root || root.includes('\0')) throw new Error('无效的工作区根目录')
  const canonical = await realpath(resolve(root))
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new Error('工作区根目录不存在')
  return canonical
}

async function resolveInsideRoot(root: string, relativePath = ''): Promise<string> {
  if (relativePath.includes('\0')) throw new Error('无效的文件路径')
  const lexical = resolve(root, relativePath)
  if (!isPathInsideRoot(root, lexical)) throw new Error('文件路径超出工作区根目录')
  const canonical = await realpath(lexical)
  if (!isPathInsideRoot(root, canonical)) throw new Error('符号链接指向工作区根目录之外')
  return canonical
}

async function entryFromPath(
  root: string,
  parent: string,
  name: string
): Promise<FileBrowserEntry | null> {
  if (name === '.git') return null
  const absolutePath = join(parent, name)
  let info
  try {
    info = await lstat(absolutePath)
  } catch {
    return null
  }

  const isSymlink = info.isSymbolicLink()
  let blocked = false
  let kind: FileBrowserEntry['kind'] = info.isDirectory() ? 'directory' : 'file'
  let size = info.size
  let modifiedAt = info.mtimeMs

  if (isSymlink) {
    try {
      const target = await realpath(absolutePath)
      blocked = !isPathInsideRoot(root, target)
      if (!blocked) {
        const targetInfo = await stat(target)
        kind = targetInfo.isDirectory() ? 'directory' : 'file'
        size = targetInfo.size
        modifiedAt = targetInfo.mtimeMs
      }
    } catch {
      blocked = true
    }
  }

  return {
    name,
    relativePath: toUiPath(relative(root, absolutePath)),
    absolutePath,
    kind,
    isSymlink,
    blocked,
    size,
    modifiedAt
  }
}

function sortEntries(entries: FileBrowserEntry[]): FileBrowserEntry[] {
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

export async function listFileBrowserDirectory(
  rootInput: string,
  relativePath = ''
): Promise<FileBrowserEntry[]> {
  const root = await canonicalRoot(rootInput)
  const directory = await resolveInsideRoot(root, relativePath)
  const directoryInfo = await stat(directory)
  if (!directoryInfo.isDirectory()) throw new Error('目标不是目录')
  const names = await readdir(directory)
  const entries = await Promise.all(names.map((name) => entryFromPath(root, directory, name)))
  return sortEntries(entries.filter((entry): entry is FileBrowserEntry => entry !== null))
}

export async function resolveFileBrowserPath(
  rootInput: string,
  relativePath: string
): Promise<string> {
  const root = await canonicalRoot(rootInput)
  return resolveInsideRoot(root, relativePath)
}

export async function relativeFileBrowserPath(
  rootInput: string,
  relativePath: string,
  fromDirectoryInput: string
): Promise<string> {
  const root = await canonicalRoot(rootInput)
  const target = await resolveInsideRoot(root, relativePath)
  const fromDirectory = await realpath(resolve(fromDirectoryInput))
  const fromInfo = await stat(fromDirectory)
  if (!fromInfo.isDirectory()) throw new Error('终端当前目录不存在')
  return relative(fromDirectory, target) || '.'
}

export async function searchFileBrowser(
  rootInput: string,
  queryInput: string
): Promise<FileBrowserEntry[]> {
  const query = queryInput.trim().toLocaleLowerCase()
  if (!query) return []
  const root = await canonicalRoot(rootInput)
  const results: FileBrowserEntry[] = []
  const queue = [root]
  let visited = 0

  while (queue.length && results.length < MAX_SEARCH_RESULTS && visited < MAX_SEARCH_ENTRIES) {
    const directory = queue.shift()!
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      continue
    }
    for (const name of names) {
      if (++visited > MAX_SEARCH_ENTRIES) break
      if (name === '.git') continue
      const entry = await entryFromPath(root, directory, name)
      if (!entry) continue
      if (entry.kind === 'file' && entry.relativePath.toLocaleLowerCase().includes(query)) {
        results.push(entry)
      }
      if (
        entry.kind === 'directory' &&
        !entry.isSymlink &&
        !entry.blocked &&
        !SEARCH_SKIPPED_DIRECTORIES.has(entry.name) &&
        results.length < MAX_SEARCH_RESULTS
      ) {
        queue.push(entry.absolutePath)
      }
      if (results.length >= MAX_SEARCH_RESULTS) break
    }
  }

  return sortEntries(results)
}

function execFileText(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error) rejectPromise(error)
        else resolvePromise(stdout)
      }
    )
  })
}

function statusFromCode(code: string): FileGitStatus {
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code)) return 'conflict'
  if (code === '??') return 'untracked'
  if (code.includes('R') || code.includes('C')) return 'renamed'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  return 'modified'
}

const STATUS_PRIORITY: Record<FileGitStatus, number> = {
  conflict: 6,
  deleted: 5,
  modified: 4,
  renamed: 3,
  added: 2,
  untracked: 1
}

function mergeStatus(
  statuses: Record<string, FileGitStatus>,
  path: string,
  status: FileGitStatus
): void {
  const current = statuses[path]
  if (!current || STATUS_PRIORITY[status] > STATUS_PRIORITY[current]) statuses[path] = status
}

export function parseGitStatusOutput(
  stdout: string,
  repositoryRoot: string,
  workspaceRoot: string
): Record<string, FileGitStatus> {
  const statuses: Record<string, FileGitStatus> = {}
  const records = stdout.split('\0')

  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const code = record.slice(0, 2)
    const repositoryPath = record.slice(3)
    if (code.includes('R') || code.includes('C')) index++
    const absolutePath = resolve(repositoryRoot, repositoryPath)
    if (!isPathInsideRoot(workspaceRoot, absolutePath)) continue
    const workspacePath = toUiPath(relative(workspaceRoot, absolutePath))
    if (!workspacePath) continue
    const status = statusFromCode(code)
    mergeStatus(statuses, workspacePath, status)

    const parts = workspacePath.split('/')
    parts.pop()
    while (parts.length) {
      mergeStatus(statuses, parts.join('/'), status)
      parts.pop()
    }
  }

  return statuses
}

export async function getFileBrowserGitStatus(
  rootInput: string
): Promise<Record<string, FileGitStatus>> {
  try {
    const workspaceRoot = await canonicalRoot(rootInput)
    const repositoryRootRaw = await execFileText(
      'git',
      ['rev-parse', '--show-toplevel'],
      workspaceRoot
    )
    const repositoryRoot = await realpath(repositoryRootRaw.trim())
    const stdout = await execFileText(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      repositoryRoot
    )
    return parseGitStatusOutput(stdout, repositoryRoot, workspaceRoot)
  } catch {
    return {}
  }
}

export async function readFileBrowserPreview(
  rootInput: string,
  relativePath: string
): Promise<FileBrowserPreview> {
  const root = await canonicalRoot(rootInput)
  const absolutePath = await resolveInsideRoot(root, relativePath)
  const info = await stat(absolutePath)
  if (!info.isFile()) throw new Error('目标不是文件')

  const base = {
    relativePath: toUiPath(relative(root, absolutePath)),
    absolutePath,
    size: info.size,
    modifiedAt: info.mtimeMs
  }
  const extension = extname(absolutePath).toLowerCase()
  const imageMime = IMAGE_MIME[extension]
  if (imageMime) {
    if (info.size > MAX_IMAGE_PREVIEW_SIZE) return { ...base, kind: 'large', mimeType: imageMime }
    const data = await readFile(absolutePath)
    return {
      ...base,
      kind: 'image',
      mimeType: imageMime,
      dataUrl: `data:${imageMime};base64,${data.toString('base64')}`
    }
  }

  const externalMime = EXTERNAL_MIME[extension]
  if (externalMime) return { ...base, kind: 'external', mimeType: externalMime }
  if (info.size > MAX_TEXT_FILE_SIZE) return { ...base, kind: 'large' }

  const data = await readFile(absolutePath)
  if (data.subarray(0, 8192).includes(0)) return { ...base, kind: 'binary' }
  const truncated = data.length > MAX_TEXT_PREVIEW_SIZE
  return {
    ...base,
    kind: 'text',
    content: data.subarray(0, MAX_TEXT_PREVIEW_SIZE).toString('utf8'),
    truncated
  }
}

function flushWatch(ownerId: string): void {
  const record = watchers.get(ownerId)
  if (!record) return
  record.timer = null
  const paths = Array.from(record.changed)
  record.changed.clear()
  record.notify(record.root, paths)
}

export async function startFileBrowserWatch(
  ownerId: string,
  rootInput: string,
  notify: (root: string, paths: string[]) => void
): Promise<void> {
  stopFileBrowserWatch(ownerId)
  const root = await canonicalRoot(rootInput)
  let watcher: FSWatcher
  try {
    watcher = watch(root, { recursive: true })
  } catch {
    watcher = watch(root)
  }
  const record: WatchRecord = {
    watcher,
    timer: null,
    root,
    changed: new Set(),
    notify
  }
  watchers.set(ownerId, record)
  watcher.on('change', (_event, filename) => {
    if (!shouldNotifyFileChange(filename)) return
    record.changed.add(toUiPath(filename!.toString()))
    if (!record.timer) record.timer = setTimeout(() => flushWatch(ownerId), 180)
  })
  watcher.on('error', () => stopFileBrowserWatch(ownerId))
}

export function stopFileBrowserWatch(ownerId: string): void {
  const record = watchers.get(ownerId)
  if (!record) return
  if (record.timer) clearTimeout(record.timer)
  record.watcher.close()
  watchers.delete(ownerId)
}

export function stopAllFileBrowserWatches(): void {
  for (const ownerId of Array.from(watchers.keys())) stopFileBrowserWatch(ownerId)
}
