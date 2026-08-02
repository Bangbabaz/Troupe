import { createReadStream, existsSync, statSync } from 'fs'
import { readdir } from 'fs/promises'
import { basename, dirname, join, sep } from 'path'
import { createInterface } from 'readline'
import { getShellRuntime, shellQuoteArgument } from './shell-runtime'
import type { AgentSessionInfo, AgentSessionProvider } from '@shared/types'

const MAX_FILES_PER_PROVIDER = 300
const MAX_LINES_PER_FILE = 120
const MAX_TITLE_LEN = 140

interface CandidateFile {
  path: string
  mtimeMs: number
}

function homePath(): string {
  return process.env.HOME || process.env.USERPROFILE || ''
}

async function walkFiles(root: string, suffix: string): Promise<CandidateFile[]> {
  if (!root || !existsSync(root)) return []
  const out: CandidateFile[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(p)
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        try {
          const st = statSync(p)
          out.push({ path: p, mtimeMs: st.mtimeMs })
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES_PER_PROVIDER)
}

function cleanText(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && 'text' in item) {
          return cleanText((item as { text?: unknown }).text)
        }
        return ''
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return ''
}

function compactTitle(text: string, fallback: string): string {
  const t = text.trim()
  if (!t) return fallback
  return t.length > MAX_TITLE_LEN ? `${t.slice(0, MAX_TITLE_LEN - 1)}...` : t
}

function commandFor(provider: AgentSessionProvider, id: string): string {
  const quotedId = shellQuoteArgument(getShellRuntime(), id)
  return provider === 'claude' ? `claude --resume ${quotedId}` : `codex resume ${quotedId}`
}

function decodeClaudeProjectPath(filePath: string): string | null {
  const projectDir = basename(dirname(filePath))
  if (!projectDir || !projectDir.includes('--')) return null
  const parts = projectDir.split('--').filter(Boolean)
  if (parts.length === 0) return null
  if (/^[A-Za-z]$/.test(parts[0])) {
    return `${parts[0]}:${sep}${parts.slice(1).join(sep)}`
  }
  return parts.join(sep)
}

async function readJsonlHead(path: string): Promise<unknown[]> {
  const rows: unknown[] = []
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  try {
    for await (const line of rl) {
      if (rows.length >= MAX_LINES_PER_FILE) break
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        rows.push(JSON.parse(trimmed))
      } catch {
        // Corrupt or partial line; skip and keep scanning a small prefix.
      }
    }
  } finally {
    rl.close()
  }
  return rows
}

function parseClaudeFile(file: CandidateFile, rows: unknown[]): AgentSessionInfo | null {
  let sessionId = ''
  let cwd: string | null = null
  let title = ''
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const obj = row as Record<string, unknown>
    if (!sessionId && typeof obj.sessionId === 'string') sessionId = obj.sessionId
    if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
    const msg = obj.message
    if (!title && msg && typeof msg === 'object') {
      const m = msg as Record<string, unknown>
      if (m.role === 'user') title = cleanText(m.content)
    }
    if (sessionId && title) break
  }
  if (!sessionId) sessionId = basename(file.path, '.jsonl')
  return {
    id: sessionId,
    provider: 'claude',
    title: compactTitle(title, 'Claude Code 会话'),
    cwd: cwd || decodeClaudeProjectPath(file.path),
    filePath: file.path,
    updatedAt: file.mtimeMs,
    command: commandFor('claude', sessionId)
  }
}

function parseCodexFile(file: CandidateFile, rows: unknown[]): AgentSessionInfo | null {
  let sessionId = ''
  let cwd: string | null = null
  let title = ''
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const obj = row as Record<string, unknown>
    const payload = obj.payload
    if (!payload || typeof payload !== 'object') continue
    const p = payload as Record<string, unknown>
    if (!sessionId && typeof p.id === 'string') sessionId = p.id
    if (!cwd && typeof p.cwd === 'string') cwd = p.cwd
    if (!title && p.type === 'user_message') title = cleanText(p.message)
    if (sessionId && title) break
  }
  if (!sessionId) {
    const m = basename(file.path, '.jsonl').match(/(019[0-9a-f-]+)$/)
    sessionId = m?.[1] || basename(file.path, '.jsonl')
  }
  return {
    id: sessionId,
    provider: 'codex',
    title: compactTitle(title, 'Codex 会话'),
    cwd,
    filePath: file.path,
    updatedAt: file.mtimeMs,
    command: commandFor('codex', sessionId)
  }
}

export async function listAgentSessions(): Promise<AgentSessionInfo[]> {
  const home = homePath()
  if (!home) return []
  const claudeRoot = join(home, '.claude', 'projects')
  const codexRoots = [join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')]

  const [claudeFiles, ...codexGroups] = await Promise.all([
    walkFiles(claudeRoot, '.jsonl'),
    ...codexRoots.map((root) => walkFiles(root, '.jsonl'))
  ])
  const codexFiles = codexGroups.flat().sort((a, b) => b.mtimeMs - a.mtimeMs)

  const sessions: AgentSessionInfo[] = []
  for (const file of claudeFiles) {
    const parsed = parseClaudeFile(file, await readJsonlHead(file.path))
    if (parsed) sessions.push(parsed)
  }
  for (const file of codexFiles.slice(0, MAX_FILES_PER_PROVIDER)) {
    const parsed = parseCodexFile(file, await readJsonlHead(file.path))
    if (parsed) sessions.push(parsed)
  }

  const deduped = new Map<string, AgentSessionInfo>()
  for (const session of sessions) {
    const key = `${session.provider}:${session.id}`
    const prev = deduped.get(key)
    if (!prev || session.updatedAt > prev.updatedAt) deduped.set(key, session)
  }

  return Array.from(deduped.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}
