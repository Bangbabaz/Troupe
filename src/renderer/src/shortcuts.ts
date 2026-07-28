export type ShortcutAction =
  | 'splitRight'
  | 'splitDown'
  | 'openDirectory'
  | 'closePane'
  | 'search'
  | 'fontSizeUp'
  | 'fontSizeDown'
  | 'fontSizeReset'
  | 'copy'
  | 'paste'
  | 'focusUp'
  | 'focusDown'
  | 'focusLeft'
  | 'focusRight'

export interface ShortcutDef {
  action: ShortcutAction
  label: string
  defaultKeys: string
}

export type ShortcutPlatform = 'darwin' | 'win32' | 'linux' | string

export const runtimePlatform: ShortcutPlatform =
  typeof window === 'undefined' ? '' : (window.electron?.process?.platform ?? '')

/**
 * Native terminals reserve Ctrl combinations for terminal input on Windows
 * and Linux. macOS uses Command for application commands, represented by the
 * canonical `Ctrl` token for compatibility with existing saved settings.
 */
export function createShortcutDefs(platform: ShortcutPlatform): ShortcutDef[] {
  const terminalCommand = platform === 'darwin' ? 'Ctrl' : 'Ctrl+Shift'

  return [
    { action: 'splitRight', label: '向右拆分', defaultKeys: 'Ctrl+Shift+D' },
    { action: 'splitDown', label: '向下拆分', defaultKeys: 'Ctrl+Shift+S' },
    { action: 'openDirectory', label: '打开目录为新面板', defaultKeys: 'Ctrl+Shift+O' },
    { action: 'closePane', label: '关闭面板', defaultKeys: 'Ctrl+Shift+W' },
    { action: 'search', label: '搜索', defaultKeys: `${terminalCommand}+F` },
    { action: 'fontSizeUp', label: '字体放大', defaultKeys: 'Ctrl+=' },
    { action: 'fontSizeDown', label: '字体缩小', defaultKeys: 'Ctrl+-' },
    { action: 'fontSizeReset', label: '字体重置', defaultKeys: 'Ctrl+0' },
    { action: 'copy', label: '复制', defaultKeys: `${terminalCommand}+C` },
    { action: 'paste', label: '粘贴', defaultKeys: `${terminalCommand}+V` },
    { action: 'focusUp', label: '焦点上移', defaultKeys: 'Alt+ArrowUp' },
    { action: 'focusDown', label: '焦点下移', defaultKeys: 'Alt+ArrowDown' },
    { action: 'focusLeft', label: '焦点左移', defaultKeys: 'Alt+ArrowLeft' },
    { action: 'focusRight', label: '焦点右移', defaultKeys: 'Alt+ArrowRight' }
  ]
}

export const SHORTCUT_DEFS: ShortcutDef[] = createShortcutDefs(runtimePlatform)

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = Object.fromEntries(
  SHORTCUT_DEFS.map((d) => [d.action, d.defaultKeys])
) as Record<ShortcutAction, string>

function codeToKey(code: string): string | null {
  if (code.startsWith('Digit')) return code.slice(5)
  const map: Record<string, string> = {
    Minus: '-',
    Equal: '=',
    Space: 'Space',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight'
  }
  return map[code] || null
}

function eventKeyName(e: KeyboardEvent): string {
  // Follow the reported character for Latin layouts (including Dvorak and
  // QWERTZ), while punctuation stays tied to the physical key like Tabby.
  if (/^[A-Za-z]$/.test(e.key)) return e.key.toUpperCase()
  return codeToKey(e.code) || e.key
}

export function eventToShortcut(
  e: KeyboardEvent,
  platform: ShortcutPlatform = runtimePlatform
): string {
  const parts: string[] = []
  if (platform === 'darwin') {
    if (e.metaKey) parts.push('Ctrl')
    if (e.ctrlKey) parts.push('Control')
  } else {
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.metaKey) parts.push('Meta')
  }
  // The =/+ key shares one physical key. Keep the existing behavior where
  // Ctrl+= and Ctrl+Shift+= both match the zoom-in binding.
  if (e.shiftKey && e.code !== 'Equal') parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(eventKeyName(e))
  return parts.join('+')
}

export function shortcutMatches(
  shortcut: string,
  e: KeyboardEvent,
  platform: ShortcutPlatform = runtimePlatform
): boolean {
  return eventToShortcut(e, platform) === shortcut
}

export function shortcutDisplayParts(
  shortcut: string,
  platform: ShortcutPlatform = runtimePlatform
): string[] {
  return shortcut.split('+').map((part) => {
    if (platform === 'darwin') {
      if (part === 'Ctrl') return '⌘'
      if (part === 'Control') return '⌃'
      if (part === 'Shift') return '⇧'
      if (part === 'Alt') return '⌥'
    }
    if (part === 'Meta') return platform === 'win32' ? 'Win' : 'Super'
    return part
  })
}
