import { resolve } from 'path'
import type { WorktreeInfo } from '@shared/types'

function normalizePathForComparison(path: string, platform: NodeJS.Platform): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized
}

export function selectRemovableWorktreePath(
  worktrees: WorktreeInfo[],
  requestedPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (!requestedPath.trim()) throw new Error('工作树路径不能为空')
  const normalizedRequested = normalizePathForComparison(requestedPath, platform)
  const target = worktrees.find(
    (worktree) => normalizePathForComparison(worktree.path, platform) === normalizedRequested
  )
  if (!target) throw new Error('目标路径不是当前仓库已注册的工作树')
  if (target.isMain) throw new Error('不能移除主工作树')
  return resolve(target.path)
}
