import { existsSync, readFileSync } from 'fs'
import { win32 } from 'path'

type PathExists = (path: string) => boolean

/** Resolve the GUI executable referenced by a Windows .cmd/.bat launcher. */
export function resolveWindowsBatchExecutable(
  content: string,
  launcherName: string,
  pathExists: PathExists = existsSync
): string | null {
  const stem = win32.basename(launcherName).replace(/\.(cmd|bat)$/i, '')
  const ideDir = content.match(/set\s+"IDE_DIR=([^"\r\n]+)"/i)?.[1]
  if (ideDir) {
    const executable = win32.join(ideDir, 'bin', `${stem}64.exe`)
    if (pathExists(executable)) return executable
  }

  const references: string[] = []
  for (const match of content.matchAll(/"([^"\r\n]+\.exe)"/gi)) references.push(match[1])
  for (const match of content.matchAll(/(?:[a-z]:\\|\\\\)[^<>"\r\n|&]*?\.exe(?=\s|$)/gim)) {
    references.push(match[0])
  }
  return references.find(pathExists) ?? null
}

export function executableFromWindowsBatch(
  launcherPath: string,
  pathExists: PathExists = existsSync
): string | null {
  if (!/\.(cmd|bat)$/i.test(launcherPath)) return null
  try {
    return resolveWindowsBatchExecutable(
      readFileSync(launcherPath, 'utf8'),
      launcherPath,
      pathExists
    )
  } catch {
    return null
  }
}
