export type TerminalKeyAction = { kind: 'write'; data: string }

export const TERMINAL_VT_EXTENSIONS = {
  kittyKeyboard: true,
  win32InputMode: true
} as const

const WIN32_ENTER_KEY_DOWN = '\x1b[13;28;13;1;0;1_'
const WIN32_ENTER_KEY_UP = '\x1b[13;28;13;0;0;1_'

export function terminalSubmitSequence(win32InputMode: boolean): string {
  // DECSET 9001 expects xterm's Win32 INPUT_RECORD encoding, including key release.
  return win32InputMode ? `${WIN32_ENTER_KEY_DOWN}${WIN32_ENTER_KEY_UP}` : '\r'
}

/**
 * Small compatibility layer for key sequences xterm does not translate the
 * same way as native terminals. Printable text and IME composition stay fully
 * owned by xterm's CompositionHelper.
 */
export class TerminalInputHandler {
  constructor(private readonly platform: string) {}

  handleKeyEvent(e: KeyboardEvent): TerminalKeyAction | null {
    if (e.type !== 'keydown' || e.isComposing || e.keyCode === 229) return null

    const ctrlOnly = e.ctrlKey && !e.altKey && !e.metaKey
    if (ctrlOnly && e.key === '/') return { kind: 'write', data: '\x1f' }
    if (ctrlOnly && e.key === '@') return { kind: 'write', data: '\x00' }

    if (this.platform !== 'win32') return null

    if (ctrlOnly && e.key === 'Backspace') return { kind: 'write', data: '\x17' }
    if (ctrlOnly && e.key === 'Delete') {
      return { kind: 'write', data: '\x1bd\x1b[3;5~' }
    }

    if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      if (e.key === 'Home') return { kind: 'write', data: '\x1b[H' }
      if (e.key === 'End') return { kind: 'write', data: '\x1b[F' }
    }

    return null
  }
}
