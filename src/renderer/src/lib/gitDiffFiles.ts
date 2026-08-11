import { parse } from 'diff2html'

export interface FilePatch {
  path: string
  status: 'new' | 'deleted' | 'renamed' | 'modified' | 'binary'
  added: number
  deleted: number
  body: string
}

const DEV_NULL = new Set(['/dev/null', 'dev/null'])
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c
}

export function decodeGitPath(value: string): string {
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char !== '\\') {
      const codePoint = value.codePointAt(i)!
      bytes.push(...encoder.encode(String.fromCodePoint(codePoint)))
      if (codePoint > 0xffff) i++
      continue
    }

    const escaped = value[++i]
    if (escaped === undefined) {
      bytes.push(0x5c)
      break
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped
      while (octal.length < 3 && i + 1 < value.length && /[0-7]/.test(value[i + 1])) {
        octal += value[++i]
      }
      bytes.push(Number.parseInt(octal, 8))
      continue
    }
    const mapped = ESCAPES[escaped]
    if (mapped !== undefined) bytes.push(mapped)
    else bytes.push(...encoder.encode(escaped))
  }
  return decoder.decode(Uint8Array.from(bytes))
}

function visiblePath(value: string | undefined): string {
  return value && !DEV_NULL.has(value) ? decodeGitPath(value) : ''
}

export function splitDiffByFile(rawDiff: string): FilePatch[] {
  if (!rawDiff) return []
  const result: FilePatch[] = []
  let current: string[] = []

  const flush = (): void => {
    if (!current.length) return
    const body = current.join('\n')
    let file: ReturnType<typeof parse>[number] | undefined
    try {
      file = parse(body)[0]
    } catch {
      // 截断的超大 diff 仍保留原始片段，文件元数据降级为 unknown。
    }
    const oldPath = visiblePath(file?.oldName)
    const newPath = visiblePath(file?.newName)
    const renamed = !!(file?.isRename || file?.isCopy)
    const status: FilePatch['status'] = file?.isNew
      ? 'new'
      : file?.isDeleted
        ? 'deleted'
        : renamed
          ? 'renamed'
          : file?.isBinary
            ? 'binary'
            : 'modified'
    const path =
      renamed && oldPath && newPath && oldPath !== newPath
        ? `${oldPath} → ${newPath}`
        : newPath || oldPath || '(unknown)'
    result.push({
      path,
      status,
      added:
        file?.addedLines ??
        current.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deleted:
        file?.deletedLines ??
        current.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      body
    })
  }

  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      current = [line]
    } else if (current.length) {
      current.push(line)
    }
  }
  flush()
  return result
}
