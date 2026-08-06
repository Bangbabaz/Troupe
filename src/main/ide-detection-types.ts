import type { IdeInfo } from '@shared/types'
import type { ShellRuntime } from './shell-runtime'

export interface IdeDetectionCandidate {
  id: string
  name: string
  bins: string[]
  extraPaths: string[]
  registryNames?: string[]
  launcherRelPath?: string
  exeRelPath?: string
  macAppNames?: string[]
  macLauncherRelPath?: string
}

export interface IdeDetectionWorkerData {
  candidates: IdeDetectionCandidate[]
  shellRuntime: ShellRuntime
}

export type IdeDetectionWorkerMessage =
  | { type: 'result'; ides: IdeInfo[] }
  | { type: 'error'; error: string }
