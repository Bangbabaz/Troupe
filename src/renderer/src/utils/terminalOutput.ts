const ESC = '\x1b'
const CODEX_SCROLLBACK_REPLAY = `${ESC}[r${ESC}[0m${ESC}[H${ESC}[2J${ESC}[3J`
const REGION_SCROLL_PATTERN = '^\\x1b\\[1;(\\d+)r\\x1b\\[(\\d+)S\\x1b\\[r'
const REGION_SCROLL = new RegExp(REGION_SCROLL_PATTERN)
const MAX_PENDING_SEQUENCE_LENGTH = 64
const REGION_SCROLL_PREFIXES = [
  '^\\x1b\\[1;\\d+$',
  '^\\x1b\\[1;\\d+r$',
  '^\\x1b\\[1;\\d+r\\x1b$',
  '^\\x1b\\[1;\\d+r\\x1b\\[$',
  '^\\x1b\\[1;\\d+r\\x1b\\[\\d+$',
  '^\\x1b\\[1;\\d+r\\x1b\\[\\d+S$',
  '^\\x1b\\[1;\\d+r\\x1b\\[\\d+S\\x1b$',
  '^\\x1b\\[1;\\d+r\\x1b\\[\\d+S\\x1b\\[$'
].map((pattern) => new RegExp(pattern))

export interface AdaptedTerminalOutput {
  data: string
  startsCodexScrollbackReplay: boolean
}

function isRegionScrollPrefix(value: string): boolean {
  if (value.length > MAX_PENDING_SEQUENCE_LENGTH) return false

  return (
    value === ESC ||
    value === `${ESC}[` ||
    value === `${ESC}[1` ||
    value === `${ESC}[1;` ||
    REGION_SCROLL_PREFIXES.some((pattern) => pattern.test(value))
  )
}

/**
 * Adapts terminal output where xterm.js intentionally differs from native
 * terminals. Codex inserts finalized history with a row-1 scroll region. In
 * xterm.js, CSI S deletes rows leaving that region instead of retaining them
 * in scrollback, so rewrite that exact sequence as an equivalent full-screen
 * scroll before Codex's synchronized repaint runs.
 */
export class XtermOutputAdapter {
  private pending = ''
  private replayScanTail = ''

  public push(chunk: string, terminalRows: number): AdaptedTerminalOutput {
    const replayScan = this.replayScanTail + chunk
    const startsCodexScrollbackReplay = replayScan.includes(CODEX_SCROLLBACK_REPLAY)
    this.replayScanTail = replayScan.slice(-(CODEX_SCROLLBACK_REPLAY.length - 1))

    let input = this.pending + chunk
    let data = ''
    this.pending = ''

    while (input) {
      const escapeIndex = input.indexOf(ESC)
      if (escapeIndex === -1) {
        data += input
        break
      }

      data += input.slice(0, escapeIndex)
      input = input.slice(escapeIndex)

      const match = REGION_SCROLL.exec(input)
      if (match) {
        const bottom = Number.parseInt(match[1], 10)
        const amount = Number.parseInt(match[2], 10)
        if (
          terminalRows > 0 &&
          bottom > 0 &&
          bottom < terminalRows &&
          amount > 0 &&
          amount <= bottom
        ) {
          data += `${ESC}[r${ESC}[999;1H${'\n'.repeat(amount)}${ESC}[H`
        } else {
          data += match[0]
        }
        input = input.slice(match[0].length)
        continue
      }

      if (isRegionScrollPrefix(input)) {
        this.pending = input
        break
      }

      data += input[0]
      input = input.slice(1)
    }

    return { data, startsCodexScrollbackReplay }
  }

  public flush(): string {
    const data = this.pending
    this.pending = ''
    this.replayScanTail = ''
    return data
  }
}
