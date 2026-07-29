export type TerminalEnvironment = Record<string, string | undefined>

function defaultTerminalProgram(
  platform: NodeJS.Platform,
  env: TerminalEnvironment
): string | null {
  if (platform === 'win32') return 'Windows_Terminal'
  if (platform === 'darwin') return 'Apple_Terminal'
  if (platform === 'linux') return env.TERMINAL?.trim() || 'x-terminal-emulator'
  return null
}

/**
 * Declare the terminal presented by the embedded PTY without replacing a
 * terminal identity inherited from the user's environment.
 */
export function createTerminalEnvironment(
  source: TerminalEnvironment = process.env,
  platform: NodeJS.Platform = process.platform
): TerminalEnvironment {
  const env = { ...source }

  env.TERM ||= 'xterm-256color'
  env.COLORTERM ||= 'truecolor'

  const terminalProgram = defaultTerminalProgram(platform, env)
  if (terminalProgram) env.TERM_PROGRAM ||= terminalProgram

  // Windows terminal applications use WT_SESSION as their capability signal.
  // Its value is opaque; consumers only require a non-empty session marker.
  if (platform === 'win32') env.WT_SESSION ||= 'default'

  return env
}
