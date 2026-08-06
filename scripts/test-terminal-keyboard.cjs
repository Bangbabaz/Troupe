/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function loadTypeScript(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const loaded = { exports: {} }
  new Function('exports', 'module', compiled)(loaded.exports, loaded)
  return loaded.exports
}

const {
  dispatchTerminalSubmit,
  TERMINAL_PASTE_SETTLE_MS,
  TERMINAL_VT_EXTENSIONS,
  TerminalInputHandler,
  TerminalPasteSubmitQueue
} = loadTypeScript('src/renderer/src/utils/terminalKeyboard.ts')
const { XtermOutputAdapter } = loadTypeScript('src/renderer/src/utils/terminalOutput.ts')
const { createTerminalEnvironment } = loadTypeScript('src/main/terminal-env.ts')
const { createShortcutDefs, eventToShortcut, shortcutDisplayParts, shortcutMatches } =
  loadTypeScript('src/renderer/src/shortcuts.ts')

function key(overrides = {}) {
  return {
    type: 'keydown',
    code: '',
    key: '',
    keyCode: 0,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides
  }
}

// Codex's row-1 region scroll must become a full-screen scroll so xterm keeps
// the displaced transcript rows in scrollback. PTY chunk boundaries may occur
// at any byte in the control sequence.
{
  const source = `before\x1b[1;20r\x1b[4S\x1b[rafter`
  const expected = `before\x1b[r\x1b[999;1H\n\n\n\n\x1b[Hafter`

  for (let split = 0; split <= source.length; split++) {
    const adapter = new XtermOutputAdapter()
    const first = adapter.push(source.slice(0, split), 24)
    const second = adapter.push(source.slice(split), 24)
    assert.equal(first.data + second.data + adapter.flush(), expected)
  }

  const charAdapter = new XtermOutputAdapter()
  let charOutput = ''
  for (const char of source) charOutput += charAdapter.push(char, 24).data
  charOutput += charAdapter.flush()
  assert.equal(charOutput, expected)
}

// Sequences that do not match Codex's bounded region operation pass through.
{
  const adapter = new XtermOutputAdapter()
  const unrelated = `\x1b[31mred\x1b[0m\x1b[1;30r\x1b[4S\x1b[r\x1b[1;24r\x1b[4S\x1b[r`
  assert.equal(adapter.push(unrelated, 24).data + adapter.flush(), unrelated)
}

// Only Codex's destructive transcript replay is reported, including when the
// sequence is split across PTY chunks. An unrelated CSI 3J stays untouched.
{
  const replay = `prefix\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3Jsuffix`
  for (let split = 0; split <= replay.length; split++) {
    const adapter = new XtermOutputAdapter()
    const first = adapter.push(replay.slice(0, split), 24)
    const second = adapter.push(replay.slice(split), 24)
    assert.equal(first.startsCodexScrollbackReplay || second.startsCodexScrollbackReplay, true)
  }

  const adapter = new XtermOutputAdapter()
  assert.equal(adapter.push('prefix\x1b[3Jsuffix', 24).startsCodexScrollbackReplay, false)
}

// Paste and submit are separated by a quiet period. Multiple Agent messages
// stay serialized instead of being merged into one composer draft.
{
  const calls = []
  const timers = []
  let nextTimerId = 1
  const queue = new TerminalPasteSubmitQueue(
    (text) => calls.push(['paste', text]),
    () => calls.push(['submit']),
    (callback, delayMs) => {
      const id = nextTimerId++
      timers.push({ id, callback, delayMs })
      return id
    },
    (timerId) => calls.push(['cancel', timerId])
  )

  const runTimer = () => {
    const timer = timers.shift()
    assert.ok(timer)
    assert.equal(timer.delayMs, TERMINAL_PASTE_SETTLE_MS)
    timer.callback()
  }

  queue.enqueue('first')
  queue.enqueue('second')
  assert.deepEqual(calls, [['paste', 'first']])

  runTimer()
  assert.deepEqual(calls, [['paste', 'first'], ['submit']])
  runTimer()
  assert.deepEqual(calls, [['paste', 'first'], ['submit'], ['paste', 'second']])
  runTimer()
  assert.deepEqual(calls, [['paste', 'first'], ['submit'], ['paste', 'second'], ['submit']])
  runTimer()
  assert.equal(timers.length, 0)

  queue.enqueue('discarded')
  queue.dispose()
  assert.deepEqual(calls.slice(-2), [
    ['paste', 'discarded'],
    ['cancel', 5]
  ])
}

assert.deepEqual(TERMINAL_VT_EXTENSIONS, {
  kittyKeyboard: true,
  win32InputMode: true
})

// Programmatic submission must travel through xterm's keyboard encoder so the
// active legacy, Kitty, or Win32 input protocol sees a real Enter key.
{
  const events = []
  dispatchTerminalSubmit(
    {
      dispatchEvent(event) {
        events.push(event)
        return true
      }
    },
    (type, init) => ({ type, ...init })
  )
  assert.deepEqual(events, [
    {
      type: 'keydown',
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
      composed: true
    },
    {
      type: 'keyup',
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
      composed: true
    }
  ])
}

// Every supported desktop platform declares its default terminal identity,
// while an identity inherited from the launch environment always wins.
{
  assert.deepEqual(createTerminalEnvironment({}, 'win32'), {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Windows_Terminal',
    WT_SESSION: 'default'
  })
  assert.deepEqual(createTerminalEnvironment({}, 'darwin'), {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Apple_Terminal'
  })
  assert.deepEqual(createTerminalEnvironment({}, 'linux'), {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'x-terminal-emulator'
  })
  assert.deepEqual(createTerminalEnvironment({ TERMINAL: 'kitty' }, 'linux'), {
    TERMINAL: 'kitty',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'kitty'
  })

  const inherited = {
    TERM: 'screen-256color',
    COLORTERM: '24bit',
    TERM_PROGRAM: 'WezTerm',
    WT_SESSION: 'existing-session'
  }
  assert.deepEqual(createTerminalEnvironment(inherited, 'win32'), inherited)
}

// Printable keys and IME events stay on xterm's native composition path.
{
  const input = new TerminalInputHandler('win32')
  assert.equal(input.handleKeyEvent(key({ code: 'Quote', key: "'", keyCode: 222 })), null)
  assert.equal(input.handleKeyEvent(key({ code: 'Digit1', key: '1', keyCode: 49 })), null)
  assert.equal(input.handleKeyEvent(key({ code: 'KeyA', key: 'Process', keyCode: 229 })), null)
  assert.equal(input.handleKeyEvent(key({ code: 'KeyA', key: 'a', isComposing: true })), null)
  assert.equal(input.handleKeyEvent(key({ code: 'Enter', key: 'Enter', shiftKey: true })), null)
}

// Match Tabby's explicit control-character fixes that xterm cannot derive on
// every keyboard layout.
{
  const input = new TerminalInputHandler('win32')
  assert.deepEqual(input.handleKeyEvent(key({ code: 'Slash', key: '/', ctrlKey: true })), {
    kind: 'write',
    data: '\x1f'
  })
  assert.deepEqual(
    input.handleKeyEvent(key({ code: 'Digit2', key: '@', ctrlKey: true, shiftKey: true })),
    { kind: 'write', data: '\x00' }
  )
  assert.equal(
    input.handleKeyEvent(key({ code: 'Slash', key: '/', ctrlKey: true, altKey: true })),
    null
  )
}

// ConPTY uses CSI Home/End, and native terminal editing maps Ctrl+Backspace
// and Ctrl+Delete to word deletion.
{
  const input = new TerminalInputHandler('win32')
  assert.deepEqual(input.handleKeyEvent(key({ code: 'Home', key: 'Home' })), {
    kind: 'write',
    data: '\x1b[H'
  })
  assert.deepEqual(input.handleKeyEvent(key({ code: 'End', key: 'End' })), {
    kind: 'write',
    data: '\x1b[F'
  })
  assert.deepEqual(
    input.handleKeyEvent(key({ code: 'Backspace', key: 'Backspace', ctrlKey: true })),
    { kind: 'write', data: '\x17' }
  )
  assert.deepEqual(input.handleKeyEvent(key({ code: 'Delete', key: 'Delete', ctrlKey: true })), {
    kind: 'write',
    data: '\x1bd\x1b[3;5~'
  })
  assert.equal(
    input.handleKeyEvent(
      key({ type: 'keyup', code: 'Backspace', key: 'Backspace', ctrlKey: true })
    ),
    null
  )
}

{
  const input = new TerminalInputHandler('linux')
  assert.equal(input.handleKeyEvent(key({ code: 'Home', key: 'Home' })), null)
  assert.equal(
    input.handleKeyEvent(key({ code: 'Backspace', key: 'Backspace', ctrlKey: true })),
    null
  )
}

// Windows/Linux reserve Ctrl+C, Ctrl+V and Ctrl+F for terminal input. macOS
// uses Command through the backwards-compatible canonical Ctrl token.
{
  const windows = Object.fromEntries(
    createShortcutDefs('win32').map((x) => [x.action, x.defaultKeys])
  )
  const mac = Object.fromEntries(createShortcutDefs('darwin').map((x) => [x.action, x.defaultKeys]))
  assert.equal(windows.copy, 'Ctrl+Shift+C')
  assert.equal(windows.paste, 'Ctrl+Shift+V')
  assert.equal(windows.search, 'Ctrl+Shift+F')
  assert.equal(mac.copy, 'Ctrl+C')
  assert.equal(mac.search, 'Ctrl+F')
}

// Meta is Win/Super away from macOS and must never trigger Ctrl shortcuts.
{
  const winF = key({ code: 'KeyF', key: 'f', metaKey: true })
  assert.equal(eventToShortcut(winF, 'win32'), 'Meta+F')
  assert.equal(shortcutMatches('Ctrl+F', winF, 'win32'), false)

  const cmdF = key({ code: 'KeyF', key: 'f', metaKey: true })
  const controlF = key({ code: 'KeyF', key: 'f', ctrlKey: true })
  assert.equal(eventToShortcut(cmdF, 'darwin'), 'Ctrl+F')
  assert.equal(eventToShortcut(controlF, 'darwin'), 'Control+F')
}

// Latin shortcuts follow the reported layout character, while the shared
// Equal key keeps Ctrl+= and Ctrl+Shift+= equivalent.
{
  assert.equal(eventToShortcut(key({ code: 'KeyY', key: 'z', ctrlKey: true }), 'win32'), 'Ctrl+Z')
  assert.equal(
    eventToShortcut(key({ code: 'Equal', key: '+', ctrlKey: true, shiftKey: true }), 'win32'),
    'Ctrl+='
  )
  assert.deepEqual(shortcutDisplayParts('Ctrl+Shift+C', 'darwin'), ['⌘', '⇧', 'C'])
  assert.deepEqual(shortcutDisplayParts('Meta+F', 'win32'), ['Win', 'F'])
}

console.log('terminal keyboard input tests passed')
