export interface WindowsBatchLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  windowsVerbatimArguments: true
}

const LAUNCHER_ENV = 'TROUPE_IDE_LAUNCHER'
const FOLDER_ENV = 'TROUPE_IDE_FOLDER'

function escapeBatchArgument(value: string): string {
  // cmd.exe reparses arguments that follow the batch launcher. Escape the two
  // metacharacters that are valid in Windows paths even inside this context.
  return value.replace(/\^/g, '^^').replace(/&/g, '^&')
}

/** Build a cmd.exe invocation without interpolating user-controlled paths. */
export function buildWindowsBatchLaunch(
  command: string,
  launcher: string,
  folder: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): WindowsBatchLaunch {
  return {
    command,
    args: ['/d', '/v:off', '/s', '/c', `""%${LAUNCHER_ENV}%" "%${FOLDER_ENV}%""`],
    env: {
      ...baseEnv,
      [LAUNCHER_ENV]: launcher,
      [FOLDER_ENV]: escapeBatchArgument(folder)
    },
    // Node otherwise escapes the quotes for CreateProcess, leaving cmd.exe
    // with a literal \" at the start of paths containing spaces.
    windowsVerbatimArguments: true
  }
}
