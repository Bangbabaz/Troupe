// Accessibility tree 获取 + 格式化。
//
// 通过注入 SNAPSHOT_SCRIPT 获取页面可交互元素列表，
// 格式化输出为 agent 友好的结构化文本。

import { evaluate } from './browser-driver'
import { SNAPSHOT_SCRIPT } from './browser-injected'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface SnapshotNode {
  ref: number
  role: string
  name: string
  tag: string
  selector: string
  value?: string
  checked?: boolean
  disabled?: boolean
  focused?: boolean
}

// TODO play 不活跃
export interface SnapshotResult {
  nodes: SnapshotNode[]
  total: number
  truncated: boolean
  summary: string
}

// ---------------------------------------------------------------------------
// 获取 accessibility tree
// ---------------------------------------------------------------------------

export async function getAccessibilitySnapshot(
  paneId: string,
  maxNodes: number = 100
): Promise<SnapshotResult> {
  const nodes = await evaluate<SnapshotNode[]>(paneId, SNAPSHOT_SCRIPT)

  if (!Array.isArray(nodes)) {
    return { nodes: [], total: 0, truncated: false, summary: 'No interactive elements found' }
  }

  const truncated = nodes.length >= maxNodes
  const result = truncated ? nodes.slice(0, maxNodes) : nodes

  return {
    nodes: result,
    total: nodes.length,
    truncated,
    summary: ''
  }
}

// ---------------------------------------------------------------------------
// 格式化输出 —— 生成 agent 友好的文本
// ---------------------------------------------------------------------------

export function formatSnapshot(snapshot: SnapshotResult): string {
  if (snapshot.nodes.length === 0) {
    return 'No interactive elements found on the page.'
  }

  const lines: string[] = []

  // 按 role 分组统计
  const roleCounts: Record<string, number> = {}
  for (const node of snapshot.nodes) {
    roleCounts[node.role] = (roleCounts[node.role] || 0) + 1
  }

  const roleSummary = Object.entries(roleCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => `${role}×${count}`)
    .join(', ')

  lines.push(`## Page Snapshot`)
  lines.push(`${roleSummary}`)
  if (snapshot.truncated) {
    lines.push(`(showing ${snapshot.nodes.length} of ${snapshot.total} elements)`)
  }
  lines.push('')

  // 渲染每个节点
  for (const node of snapshot.nodes) {
    const badges: string[] = []

    if (node.focused) badges.push('[focused]')
    if (node.disabled) badges.push('[disabled]')
    if (node.checked !== undefined) badges.push(node.checked ? '[✓]' : '[ ]')
    if (node.value) badges.push(`value="${node.value}"`)

    const badgeText = badges.length > 0 ? ' ' + badges.join(' ') : ''
    const nameText = node.name ? `"${node.name}"` : `(${node.tag})`
    const roleText = node.role !== node.tag ? ` [${node.role}]` : ''

    lines.push(`- [${node.ref}]${badgeText} ${nameText}${roleText} → \`${node.selector}\``)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 获取前 N 个元素（用于 navigate 返回值中的 quickSnapshot）
// ---------------------------------------------------------------------------

export async function getQuickSnapshot(paneId: string, topN: number = 10): Promise<SnapshotNode[]> {
  const nodes = await evaluate<SnapshotNode[]>(paneId, SNAPSHOT_SCRIPT)
  if (!Array.isArray(nodes)) return []
  return nodes.slice(0, topN)
}
