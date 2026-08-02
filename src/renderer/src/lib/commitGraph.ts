import type { CommitInfo } from '@shared/types'

// 提交图(commit graph)布局算法。GitLogViewer 用本模块产出的 row 列表在每条
// commit 左侧画 lane 圆点 + 上下连接线。
//
// 算法思路:维护 `lanes` —— 当前每条 lane "正在等待哪个 parent hash 出现"。
// 按 commit 顺序(最新→最旧)迭代:
//   1. 找到当前 commit.hash 在 lanes 中所占的位置(ownLane);第一次出现就分配空位
//   2. 上半段画线:每条 prev lane 都是从 (i, 顶) → (i, 中心) 的竖线 —— lane 槽
//      位绝不重排,所以"穿过"的 lane 自然就是竖线
//   3. 消费 ownLane；当前列表可见的 parents 复用已有等待者或进入空 lane，主
//      parent 通常优先继承 ownLane，不可见 parent 不占 lane
//   4. 下半段画线:ownLane 连接到各 parentLane，既有 lane 同时竖直穿过本行
//      —— 分叉与收敛都能保持连续
//
// 颜色:lane 索引循环 → EL 语义色 token + 一组固定补色。每条 lane 一旦分配颜色
// 就保持到 lane 终结,主线 + 分支线视觉一致。

export interface GraphSegment {
  fromLane: number
  toLane: number
  color: string
}

export interface GraphRow {
  /** 圆点所在 lane index。 */
  ownLane: number
  /** 圆点颜色 = 该 lane 的颜色。 */
  dotColor: string
  /** 上半段(顶 → 中心)绘制的线段。 */
  topSegments: GraphSegment[]
  /** 下半段(中心 → 底)绘制的线段。 */
  bottomSegments: GraphSegment[]
  /** 本行需要展示的 lane 总数(决定 SVG 宽度)。 */
  laneCount: number
  /** parents.length > 1 —— merge commit,圆点用空心表达。 */
  isMerge: boolean
  /** 通过 commit hash 反查所属 commit,方便上层渲染时 zip 起来。 */
  hash: string
}

// lane 颜色循环。前 5 个是 EL 语义色 token,后面是固定补色 —— EL 没有更多语义
// 槽位,用补色保证 6+ lane 仍能区分。固定补色在 dark/light 主题下都可读。
const LANE_COLORS = [
  'var(--el-color-primary)',
  'var(--el-color-success)',
  'var(--el-color-warning)',
  'var(--el-color-danger)',
  'var(--el-color-info)',
  '#7c4dff',
  '#ff8a65',
  '#26a69a',
  '#ec407a',
  '#9ccc65'
]

function colorForLane(idx: number): string {
  return LANE_COLORS[idx % LANE_COLORS.length]
}

export function computeGraph(commits: CommitInfo[]): GraphRow[] {
  const rows: GraphRow[] = []
  const lanes: Array<{ hash: string; color: string } | null> = []
  const remainingHashes = new Set(commits.map((commit) => commit.hash))

  for (const commit of commits) {
    remainingHashes.delete(commit.hash)

    // ---- 找到 / 分配 ownLane ----
    let ownLane = lanes.findIndex((l) => l?.hash === commit.hash)
    let ownColor: string
    if (ownLane < 0) {
      const empty = lanes.findIndex((l) => l === null)
      ownLane = empty >= 0 ? empty : lanes.length
      if (empty < 0) lanes.push(null)
      ownColor = colorForLane(ownLane)
    } else {
      ownColor = lanes[ownLane]!.color
    }

    // 拍照 prev lanes 用于上半段绘制 —— 必须在 mutate lanes 之前。
    const prevLanes = lanes.slice()

    // ---- 更新 lanes ----
    // 当前 commit 已经消费掉 ownLane。父提交若已经由另一条 lane 等待，必须
    // 汇入那条 lane；继续把同一个 parent 留在 ownLane 会制造永不收敛的重复线。
    lanes[ownLane] = null
    const parentLanes = new Map<string, number>()
    const existingParentLanes = new Set<number>()
    for (let pi = 0; pi < commit.parents.length; pi++) {
      const p = commit.parents[pi]
      // grep/author 过滤以及分页末尾都可能让直接 parent 不在当前列表中。
      // 对不可见 parent 继续分配 lane 会让每一行都新增一列并越界绘制。
      if (!remainingHashes.has(p)) continue

      const existing = lanes.findIndex((l) => l?.hash === p)
      if (existing >= 0) {
        parentLanes.set(p, existing)
        existingParentLanes.add(existing)
        continue
      }

      const empty = lanes.findIndex((l) => l === null)
      const idx = empty >= 0 ? empty : lanes.length
      if (empty < 0) lanes.push(null)
      lanes[idx] = { hash: p, color: pi === 0 ? ownColor : colorForLane(idx) }
      parentLanes.set(p, idx)
    }

    // 截短尾部 null —— 防止 lane 数无限增长(merge 之后 lane 减少时)
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()

    // ---- 上半段:prevLanes 里每个 non-null 的 lane 画一条竖线 ----
    const topSegments: GraphSegment[] = []
    for (let i = 0; i < prevLanes.length; i++) {
      const prev = prevLanes[i]
      if (!prev) continue
      topSegments.push({ fromLane: i, toLane: i, color: prev.color })
    }

    // ---- 下半段 ----
    // 1) 每个可见 parent:圆点到该 parent 所在 lane 的连线
    // 2) 主 parent 通常继承 ownLane；若它已在其它 lane，则画收敛斜线
    // 3) 其它穿过的 lane:本身竖线
    const bottomSegments: GraphSegment[] = []
    const connectedLanes = new Set<number>()
    for (const p of commit.parents) {
      const parentLane = parentLanes.get(p)
      if (parentLane == null) continue
      bottomSegments.push({
        fromLane: ownLane,
        toLane: parentLane,
        color: lanes[parentLane]!.color
      })
      connectedLanes.add(parentLane)
    }
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i]
      if (!l) continue
      // 新分配的 parent lane 已由 node -> parent 的连线覆盖；原本就存在
      // 的 parent lane 还代表其它 descendant，必须继续竖直穿过本行。
      if (connectedLanes.has(i) && !existingParentLanes.has(i)) continue
      bottomSegments.push({ fromLane: i, toLane: i, color: l.color })
    }

    rows.push({
      ownLane,
      dotColor: ownColor,
      topSegments,
      bottomSegments,
      laneCount: Math.max(prevLanes.length, lanes.length, ownLane + 1),
      isMerge: commit.parents.length > 1,
      hash: commit.hash
    })
  }

  return rows
}

// 绘制参数 —— GitLogViewer 共享这些常量,所以宽度计算 / 圆点定位用同一套数。
export const GRAPH = {
  /** lane 间距(像素) */
  laneStep: 14,
  /** 第一条 lane 中心的左偏移 */
  leftPad: 8,
  /** 单行 graph SVG 高度 = commit row 高度。覆盖单行 padding,与 .gl-row 同步。 */
  rowHeight: 36,
  /** 圆点半径 */
  dotRadius: 4
}

/** 计算 lane i 中心的 x 坐标。 */
export function laneCenterX(i: number): number {
  return GRAPH.leftPad + i * GRAPH.laneStep
}
