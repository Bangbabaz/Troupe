export type TerminalKeyAction = { kind: 'write'; data: string }

export const TERMINAL_VT_EXTENSIONS = {
  kittyKeyboard: true,
  win32InputMode: true
} as const

type KeyboardEventFactory = (type: 'keydown' | 'keyup', init: KeyboardEventInit) => Event
type TimerScheduler = (callback: () => void, delayMs: number) => number
type TimerCanceler = (timerId: number) => void

export const TERMINAL_PASTE_SETTLE_MS = 250

function createKeyboardEvent(type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent(type, init)
  // Chromium does not consistently initialize these deprecated fields, but
  // xterm's legacy encoder still consults keyCode when no enhanced protocol is active.
  if (event.keyCode !== 13) Reflect.defineProperty(event, 'keyCode', { value: 13 })
  if (event.which !== 13) Reflect.defineProperty(event, 'which', { value: 13 })
  return event
}

export function dispatchTerminalSubmit(
  target: Pick<EventTarget, 'dispatchEvent'>,
  eventFactory: KeyboardEventFactory = createKeyboardEvent
): void {
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    composed: true
  }
  target.dispatchEvent(eventFactory('keydown', init))
  target.dispatchEvent(eventFactory('keyup', init))
}

/**
 * Keep submit outside the terminal's paste burst and serialize messages so a
 * second delivery cannot be appended to the first draft before it is sent.
 */
export class TerminalPasteSubmitQueue {
  private readonly pending: string[] = []
  private timerId: number | null = null
  private active = false
  private disposed = false

  constructor(
    private readonly paste: (text: string) => void,
    private readonly submit: () => void,
    private readonly schedule: TimerScheduler = (callback, delayMs) =>
      window.setTimeout(callback, delayMs),
    private readonly cancel: TimerCanceler = (timerId) => window.clearTimeout(timerId),
    private readonly settleMs = TERMINAL_PASTE_SETTLE_MS
  ) {}

  enqueue(text: string): void {
    if (this.disposed) return
    this.pending.push(text)
    if (!this.active) this.pasteNext()
  }

  dispose(): void {
    this.disposed = true
    this.pending.length = 0
    if (this.timerId !== null) this.cancel(this.timerId)
    this.timerId = null
  }

  private pasteNext(): void {
    const text = this.pending.shift()
    if (text === undefined || this.disposed) {
      this.active = false
      return
    }

    this.active = true
    this.paste(text)
    this.timerId = this.schedule(() => {
      this.timerId = null
      if (this.disposed) return
      this.submit()
      this.timerId = this.schedule(() => {
        this.timerId = null
        if (this.disposed) return
        this.active = false
        this.pasteNext()
      }, this.settleMs)
    }, this.settleMs)
  }
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
