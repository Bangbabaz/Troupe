import { computed, ref, onMounted, onUnmounted, type Ref, type ComputedRef } from 'vue'
import type { SavedLayout, SavedTerminalState } from '@shared/types'

// 分屏布局核心:二叉树 LayoutNode + 像素级 rect 计算 + 拖拽逻辑。
//
// 之前全部塞在 App.vue 里(700+ 行单文件),拆出来后 App 只剩"打理 layout 上方
// 的协调工作"(设置抽屉、tasks drawer、快捷键录制),而本 composable 专注于
// pane tree 本身的几何 + 交互。
//
// 注:layout 持久化(写 settings.paneLayout)由 App.vue 决定时机 —— composable
// 暴露 serialize/deserialize,saves 的节奏归 App 安排,因为 settings.json 也
// 装着 fontSize / scrollback 等本 composable 看不见的字段。

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type Pane = { type: 'pane'; id: string }
export type Split = {
  type: 'split'
  direction: 'row' | 'column'
  ratio: number
  a: LayoutNode
  b: LayoutNode
}
export type LayoutNode = Pane | Split

export type Rect = { left: number; top: number; width: number; height: number }

export type DropZone = 'left' | 'right' | 'top' | 'bottom'

export interface DividerItem {
  rect: Rect
  direction: 'row' | 'column'
  path: string[]
  ratio: number
  totalSize: number
}

interface DragState {
  path: string[]
  direction: 'row' | 'column'
  startX: number
  startY: number
  startRatio: number
  totalSize: number
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DIVIDER = 4
const MIN_PANE = 60 // px — 比这更小不再允许 split
const MIN_RATIO = 0.05
const MAX_RATIO = 0.95

const PLACEMENT_MAP: Record<
  'top' | 'bottom' | 'left' | 'right',
  { direction: 'row' | 'column'; newFirst: boolean }
> = {
  right: { direction: 'row', newFirst: false },
  left: { direction: 'row', newFirst: true },
  bottom: { direction: 'column', newFirst: false },
  top: { direction: 'column', newFirst: true }
}

const ZONE_MAP: Record<DropZone, { direction: 'row' | 'column'; newFirst: boolean }> = {
  left: { direction: 'row', newFirst: true },
  right: { direction: 'row', newFirst: false },
  top: { direction: 'column', newFirst: true },
  bottom: { direction: 'column', newFirst: false }
}

function isSavedPaneId(id: unknown): id is string {
  return typeof id === 'string' && /^pane-[A-Za-z0-9_-]+-\d+$/.test(id)
}

// ---------------------------------------------------------------------------
// 纯函数:tree 操作 / rect 计算
// ---------------------------------------------------------------------------

let paneCounter = 0
export function newPaneId(): string {
  return `pane-${Date.now().toString(36)}-${++paneCounter}`
}

function updateRatio(node: LayoutNode, path: string[], ratio: number): LayoutNode {
  if (path.length === 0) {
    if (node.type === 'split') return { ...node, ratio }
    return node
  }
  if (node.type === 'pane') return node
  const [dir, ...rest] = path
  if (dir === 'a') return { ...node, a: updateRatio(node.a, rest, ratio) }
  return { ...node, b: updateRatio(node.b, rest, ratio) }
}

function insertSplit(
  node: LayoutNode,
  targetId: string,
  newId: string,
  direction: 'row' | 'column'
): LayoutNode {
  if (node.type === 'pane') {
    if (node.id !== targetId) return node
    return {
      type: 'split',
      direction,
      ratio: 0.5,
      a: node,
      b: { type: 'pane', id: newId }
    }
  }
  const a = insertSplit(node.a, targetId, newId, direction)
  const b = insertSplit(node.b, targetId, newId, direction)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

function insertAdjacent(
  node: LayoutNode,
  targetId: string,
  newNode: LayoutNode,
  direction: 'row' | 'column',
  newFirst: boolean
): LayoutNode {
  if (node.type === 'pane') {
    if (node.id !== targetId) return node
    return {
      type: 'split',
      direction,
      ratio: 0.5,
      a: newFirst ? newNode : node,
      b: newFirst ? node : newNode
    }
  }
  const a = insertAdjacent(node.a, targetId, newNode, direction, newFirst)
  const b = insertAdjacent(node.b, targetId, newNode, direction, newFirst)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

function removePaneFromTree(node: LayoutNode, targetId: string): LayoutNode | null {
  if (node.type === 'pane') {
    return node.id === targetId ? null : node
  }
  const a = removePaneFromTree(node.a, targetId)
  const b = removePaneFromTree(node.b, targetId)
  if (a === null && b === null) return null
  if (a === null) return b
  if (b === null) return a
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

function firstLeafId(node: LayoutNode): string {
  return node.type === 'pane' ? node.id : firstLeafId(node.a)
}

function collect(
  node: LayoutNode,
  rect: Rect,
  panes: Array<{ id: string; rect: Rect }>,
  dividers: Array<DividerItem>,
  path: string[] = []
): void {
  if (node.type === 'pane') {
    panes.push({ id: node.id, rect })
    return
  }
  if (node.direction === 'row') {
    const usable = Math.max(0, rect.width - DIVIDER)
    const aW = Math.max(0, Math.floor(usable * node.ratio))
    const bW = Math.max(0, usable - aW)
    collect(
      node.a,
      { left: rect.left, top: rect.top, width: aW, height: rect.height },
      panes,
      dividers,
      [...path, 'a']
    )
    dividers.push({
      rect: { left: rect.left + aW, top: rect.top, width: DIVIDER, height: rect.height },
      direction: 'row',
      path: [...path],
      ratio: node.ratio,
      totalSize: rect.width
    })
    collect(
      node.b,
      { left: rect.left + aW + DIVIDER, top: rect.top, width: bW, height: rect.height },
      panes,
      dividers,
      [...path, 'b']
    )
  } else {
    const usable = Math.max(0, rect.height - DIVIDER)
    const aH = Math.max(0, Math.floor(usable * node.ratio))
    const bH = Math.max(0, usable - aH)
    collect(
      node.a,
      { left: rect.left, top: rect.top, width: rect.width, height: aH },
      panes,
      dividers,
      [...path, 'a']
    )
    dividers.push({
      rect: { left: rect.left, top: rect.top + aH, width: rect.width, height: DIVIDER },
      direction: 'column',
      path: [...path],
      ratio: node.ratio,
      totalSize: rect.height
    })
    collect(
      node.b,
      { left: rect.left, top: rect.top + aH + DIVIDER, width: rect.width, height: bH },
      panes,
      dividers,
      [...path, 'b']
    )
  }
}

// ---------------------------------------------------------------------------
// composable
// ---------------------------------------------------------------------------

export interface UseLayoutOptions {
  /** 容器像素尺寸,通常来自 App.vue 的 ResizeObserver。 */
  containerSize: Ref<{ width: number; height: number }>
  /**
   * 容器 DOM ref —— App.vue 的模板 `ref="containerRef"` 绑定的同一个对象。
   * pane 拖拽 (onPaneDragMove) 用它的 getBoundingClientRect 算鼠标在容器内的
   * 坐标,必须是真正绑到 DOM 的那个 ref;之前 useLayout 内部 own 一个未绑定
   * 的 ref,结果是 undefined,pane 拖拽得到 null 坐标 → 整个 drop target
   * 计算失效。这里改为由调用方传入,保证一定指向真正的容器元素。
   */
  containerRef: Ref<HTMLDivElement | undefined>
  /** 默认 cwd —— 没有 paneCwd entry 的 pane fallback 到此。 */
  defaultCwd: Ref<string | null>
  /** 持久化 hook:layout 或 paneCwd 变化后 App 想知道何时写盘。 */
  onChange?: () => void
}

export interface UseLayoutReturn {
  layout: Ref<LayoutNode | null>
  activeId: Ref<string | null>
  paneCwd: Ref<Record<string, string>>
  paneWorkspaceRoot: Ref<Record<string, string>>
  paneTerminalState: Ref<Record<string, SavedTerminalState>>
  dragState: Ref<DragState | null>
  paneDrag: Ref<{ id: string } | null>
  dropTarget: Ref<{ id: string; zone: DropZone } | null>
  layoutResult: ComputedRef<{
    panes: Array<{ id: string; rect: Rect }>
    dividers: Array<DividerItem>
  }>
  draggedRect: ComputedRef<Rect | null>
  dropIndicatorRect: ComputedRef<Rect | null>

  onSplit: (paneId: string, direction: 'row' | 'column', overrideCwd?: string) => string | null
  onClose: (paneId: string) => void
  onCreateWorktree: (
    paneId: string,
    worktreePath: string,
    placement?: 'top' | 'bottom' | 'left' | 'right'
  ) => void
  setActive: (id: string) => void
  onCwdChange: (paneId: string, newCwd: string) => void
  onWorkspaceRootChange: (paneId: string, root: string) => void
  /**
   * 移动焦点到相邻面板。dir 是物理方向 —— 在当前 active pane 的几何坐标里,
   * 沿该方向找一个面板让 active 跳过去。tmux 风格 Alt+方向键的实现。
   */
  focusNeighbor: (dir: 'up' | 'down' | 'left' | 'right') => boolean

  onDividerDown: (e: MouseEvent, idx: number) => void
  onDividerDoubleClick: (e: MouseEvent, idx: number) => void

  onPaneDragStart: (paneId: string) => void

  serializeLayout: () => SavedLayout | null
  restoreFromSaved: (saved: SavedLayout | null | undefined) => void
}

export function useLayout(opts: UseLayoutOptions): UseLayoutReturn {
  const layout: Ref<LayoutNode | null> = ref(null)
  const paneCwd = ref<Record<string, string>>({})
  const paneWorkspaceRoot = ref<Record<string, string>>({})
  const paneTerminalState = ref<Record<string, SavedTerminalState>>({})
  const activeId = ref<string | null>(null)
  const dragState = ref<DragState | null>(null)
  const paneDrag = ref<{ id: string } | null>(null)
  const dropTarget = ref<{ id: string; zone: DropZone } | null>(null)
  // containerRef 由调用方持有 + 绑定模板,这里只取个别名给内部函数用
  const containerRef = opts.containerRef

  // ---- layout 计算 -------------------------------------------------------
  const layoutResult = computed(() => {
    const panes: Array<{ id: string; rect: Rect }> = []
    const dividers: Array<DividerItem> = []
    if (layout.value && opts.containerSize.value.width > 0 && opts.containerSize.value.height > 0) {
      collect(
        layout.value,
        {
          left: 0,
          top: 0,
          width: opts.containerSize.value.width,
          height: opts.containerSize.value.height
        },
        panes,
        dividers
      )
    }
    return { panes, dividers }
  })

  const findPaneRect = (id: string): Rect | null => {
    const found = layoutResult.value.panes.find((p) => p.id === id)
    return found ? found.rect : null
  }

  // ---- 操作 --------------------------------------------------------------
  const onSplit = (
    paneId: string,
    direction: 'row' | 'column',
    overrideCwd?: string
  ): string | null => {
    if (!layout.value) return null
    const rect = findPaneRect(paneId)
    if (rect) {
      const dim = direction === 'row' ? rect.width : rect.height
      if (dim < MIN_PANE * 2 + DIVIDER) return null
    }
    const newId = newPaneId()
    layout.value = insertSplit(layout.value, paneId, newId, direction)
    if (overrideCwd !== undefined) {
      paneCwd.value = { ...paneCwd.value, [newId]: overrideCwd }
    } else if (paneCwd.value[paneId]) {
      paneCwd.value = { ...paneCwd.value, [newId]: paneCwd.value[paneId] }
    }
    const inheritedRoot =
      overrideCwd ??
      paneWorkspaceRoot.value[paneId] ??
      paneCwd.value[paneId] ??
      opts.defaultCwd.value
    if (inheritedRoot) {
      paneWorkspaceRoot.value = { ...paneWorkspaceRoot.value, [newId]: inheritedRoot }
    }
    const inheritedTerminal = paneTerminalState.value[paneId]
    if (inheritedTerminal?.kind === 'ssh') {
      paneTerminalState.value = { ...paneTerminalState.value, [newId]: inheritedTerminal }
    }
    activeId.value = newId
    return newId
  }

  const onClose = (paneId: string): void => {
    if (!layout.value) return
    const next = removePaneFromTree(layout.value, paneId)
    if (next === null) {
      const newId = newPaneId()
      layout.value = { type: 'pane', id: newId }
      paneCwd.value = {}
      paneWorkspaceRoot.value = {}
      paneTerminalState.value = {}
      activeId.value = newId
      return
    }
    layout.value = next
    if (paneCwd.value[paneId]) {
      const rest = { ...paneCwd.value }
      delete rest[paneId]
      paneCwd.value = rest
    }
    if (paneWorkspaceRoot.value[paneId]) {
      const rest = { ...paneWorkspaceRoot.value }
      delete rest[paneId]
      paneWorkspaceRoot.value = rest
    }
    if (paneTerminalState.value[paneId]) {
      const rest = { ...paneTerminalState.value }
      delete rest[paneId]
      paneTerminalState.value = rest
    }
    if (activeId.value === paneId) {
      activeId.value = firstLeafId(next)
    }
  }

  const onCreateWorktree = (
    paneId: string,
    worktreePath: string,
    placement: 'top' | 'bottom' | 'left' | 'right' = 'right'
  ): void => {
    if (!layout.value) return
    const rect = findPaneRect(paneId)
    const resolved = (
      placement: 'top' | 'bottom' | 'left' | 'right'
    ): 'top' | 'bottom' | 'left' | 'right' | null => {
      const dir = PLACEMENT_MAP[placement].direction
      if (!rect) return placement
      const dim = dir === 'row' ? rect.width : rect.height
      if (dim >= MIN_PANE * 2 + DIVIDER) return placement
      // 用户挑的方向太窄,自动尝试垂直方向(left/right ↔ top/bottom):
      // 大多数 worktree 创建发生在窄/高的 pane 上,90° 方向通常够。
      const flip: Record<typeof placement, 'top' | 'bottom' | 'left' | 'right'> = {
        left: 'top',
        right: 'bottom',
        top: 'left',
        bottom: 'right'
      }
      const alt = flip[placement]
      const altDim = PLACEMENT_MAP[alt].direction === 'row' ? rect.width : rect.height
      if (altDim >= MIN_PANE * 2 + DIVIDER) return alt
      return null
    }

    const finalPlacement = resolved(placement)
    if (!finalPlacement) {
      // 两个方向都开不出一个可用尺寸的子 pane —— 与 onSplit 的 silent-fail 一致,
      // 但已创建的 worktree 不应该被"丢"。退而求其次:把当前 pane 的 cwd 改到
      // 新 worktree,用户至少能立刻进去工作,可以稍后用 split 自行打开邻居 pane。
      paneCwd.value = { ...paneCwd.value, [paneId]: worktreePath }
      paneWorkspaceRoot.value = { ...paneWorkspaceRoot.value, [paneId]: worktreePath }
      if (paneTerminalState.value[paneId]) {
        const rest = { ...paneTerminalState.value }
        delete rest[paneId]
        paneTerminalState.value = rest
      }
      return
    }

    const newId = newPaneId()
    const { direction, newFirst } = PLACEMENT_MAP[finalPlacement]
    layout.value = insertAdjacent(
      layout.value,
      paneId,
      { type: 'pane', id: newId },
      direction,
      newFirst
    )
    paneCwd.value = { ...paneCwd.value, [newId]: worktreePath }
    paneWorkspaceRoot.value = { ...paneWorkspaceRoot.value, [newId]: worktreePath }
    if (paneTerminalState.value[newId]) {
      const rest = { ...paneTerminalState.value }
      delete rest[newId]
      paneTerminalState.value = rest
    }
    activeId.value = newId
  }

  const setActive = (id: string): void => {
    activeId.value = id
  }

  const onCwdChange = (paneId: string, newCwd: string): void => {
    if (!paneWorkspaceRoot.value[paneId]) {
      paneWorkspaceRoot.value = { ...paneWorkspaceRoot.value, [paneId]: newCwd }
    }
    if (paneCwd.value[paneId] !== newCwd) {
      paneCwd.value = { ...paneCwd.value, [paneId]: newCwd }
    }
  }

  const onWorkspaceRootChange = (paneId: string, root: string): void => {
    if (!root || paneWorkspaceRoot.value[paneId] === root) return
    paneWorkspaceRoot.value = { ...paneWorkspaceRoot.value, [paneId]: root }
  }

  // ---- 邻接焦点切换 (tmux Alt+方向键 风格) -------------------------------
  // 思路:在 layoutResult.panes 里找一个 rect 与 active rect 在指定方向上有重叠
  // 区间、且在该方向上"紧邻"的 pane。返回是否切换成功 —— 没找到时 false,
  // 调用方据此决定是否让快捷键回退到 xterm(并不需要)。
  const focusNeighbor = (dir: 'up' | 'down' | 'left' | 'right'): boolean => {
    const id = activeId.value
    if (!id) return false
    const me = findPaneRect(id)
    if (!me) return false
    const panes = layoutResult.value.panes.filter((p) => p.id !== id)
    // 1) 过滤出方向上"在外侧"的 panes
    const meCx = me.left + me.width / 2
    const meCy = me.top + me.height / 2
    const candidates: Array<{ id: string; rect: Rect; dist: number }> = []
    for (const p of panes) {
      const r = p.rect
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      let pass = false
      // 在指定方向上,被选 pane 中心要在 active 中心的"外侧"
      // 且二者在垂直/水平投影上有重叠(说明真的相邻而非斜对角)。
      if (dir === 'left') {
        pass = cx < meCx && r.top < me.top + me.height && r.top + r.height > me.top
      } else if (dir === 'right') {
        pass = cx > meCx && r.top < me.top + me.height && r.top + r.height > me.top
      } else if (dir === 'up') {
        pass = cy < meCy && r.left < me.left + me.width && r.left + r.width > me.left
      } else {
        pass = cy > meCy && r.left < me.left + me.width && r.left + r.width > me.left
      }
      if (!pass) continue
      // 距离:方向轴上的距离 + 垂直轴上的中心偏移(消歧两个并排候选时取更近的)
      const axisDist = dir === 'left' || dir === 'right' ? Math.abs(cx - meCx) : Math.abs(cy - meCy)
      const crossDist =
        dir === 'left' || dir === 'right' ? Math.abs(cy - meCy) : Math.abs(cx - meCx)
      candidates.push({ id: p.id, rect: r, dist: axisDist * 1000 + crossDist })
    }
    if (!candidates.length) return false
    candidates.sort((a, b) => a.dist - b.dist)
    activeId.value = candidates[0].id
    return true
  }

  // ---- divider 拖拽 ------------------------------------------------------
  const onDividerDown = (e: MouseEvent, idx: number): void => {
    const d = layoutResult.value.dividers[idx]
    if (!d) return
    dragState.value = {
      path: d.path,
      direction: d.direction,
      startX: e.clientX,
      startY: e.clientY,
      startRatio: d.ratio,
      totalSize: d.totalSize
    }
    e.preventDefault()
  }

  const onDividerMove = (e: MouseEvent): void => {
    if (!dragState.value || !layout.value) return
    const ds = dragState.value
    const delta = ds.direction === 'row' ? e.clientX - ds.startX : e.clientY - ds.startY
    const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ds.startRatio + delta / ds.totalSize))
    layout.value = updateRatio(layout.value, ds.path, ratio)
  }

  const onDividerDoubleClick = (e: MouseEvent, idx: number): void => {
    const d = layoutResult.value.dividers[idx]
    if (!d || !layout.value) return
    dragState.value = null
    layout.value = updateRatio(layout.value, d.path, 0.5)
    e.preventDefault()
  }

  const onDividerUp = (): void => {
    dragState.value = null
  }

  // ---- pane 拖拽重排 -----------------------------------------------------
  const onPaneDragStart = (paneId: string): void => {
    paneDrag.value = { id: paneId }
    dropTarget.value = null
  }

  const zoneForPoint = (rect: Rect, mx: number, my: number): DropZone => {
    const fx = (mx - rect.left) / rect.width - 0.5
    const fy = (my - rect.top) / rect.height - 0.5
    if (Math.abs(fx) >= Math.abs(fy)) return fx < 0 ? 'left' : 'right'
    return fy < 0 ? 'top' : 'bottom'
  }

  const onPaneDragMove = (e: MouseEvent): void => {
    if (!paneDrag.value || !containerRef.value) return
    const root = containerRef.value.getBoundingClientRect()
    const mx = e.clientX - root.left
    const my = e.clientY - root.top
    const hit = layoutResult.value.panes.find(
      (p) =>
        mx >= p.rect.left &&
        mx <= p.rect.left + p.rect.width &&
        my >= p.rect.top &&
        my <= p.rect.top + p.rect.height
    )
    if (!hit || hit.id === paneDrag.value.id) {
      dropTarget.value = null
      return
    }
    dropTarget.value = { id: hit.id, zone: zoneForPoint(hit.rect, mx, my) }
  }

  const onPaneDragUp = (): void => {
    const drag = paneDrag.value
    const target = dropTarget.value
    paneDrag.value = null
    dropTarget.value = null
    if (!drag || !target || !layout.value || drag.id === target.id) return
    const removed = removePaneFromTree(layout.value, drag.id)
    if (!removed) return
    const { direction, newFirst } = ZONE_MAP[target.zone]
    const next = insertAdjacent(
      removed,
      target.id,
      { type: 'pane', id: drag.id },
      direction,
      newFirst
    )
    if (next === removed) return
    layout.value = next
    activeId.value = drag.id
  }

  const onPaneDragKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && paneDrag.value) {
      paneDrag.value = null
      dropTarget.value = null
    }
  }

  // ---- 衍生 rect ---------------------------------------------------------
  const draggedRect = computed<Rect | null>(() =>
    paneDrag.value ? findPaneRect(paneDrag.value.id) : null
  )
  const dropIndicatorRect = computed<Rect | null>(() => {
    const t = dropTarget.value
    if (!t) return null
    const r = findPaneRect(t.id)
    if (!r) return null
    if (t.zone === 'left') return { left: r.left, top: r.top, width: r.width / 2, height: r.height }
    if (t.zone === 'right')
      return { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height }
    if (t.zone === 'top') return { left: r.left, top: r.top, width: r.width, height: r.height / 2 }
    return { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 }
  })

  // ---- 序列化 ------------------------------------------------------------
  const serializeNode = (node: LayoutNode): SavedLayout => {
    if (node.type === 'pane') {
      return {
        type: 'pane',
        id: node.id,
        cwd: paneCwd.value[node.id] || opts.defaultCwd.value || '',
        workspaceRoot:
          paneWorkspaceRoot.value[node.id] || paneCwd.value[node.id] || opts.defaultCwd.value || '',
        terminal: paneTerminalState.value[node.id] || { kind: 'local' }
      }
    }
    return {
      type: 'split',
      direction: node.direction,
      ratio: node.ratio,
      a: serializeNode(node.a),
      b: serializeNode(node.b)
    }
  }

  const serializeLayout = (): SavedLayout | null =>
    layout.value ? serializeNode(layout.value) : null

  // settings.json 是用户可手动编辑的 —— 备份恢复、同步工具搬运、版本回滚都
  // 可能引入损坏(深度异常 / 字段缺失 / 类型不对)。超过这个深度的 layout 直接
  // fallback 到单 pane,避免无限递归把 renderer 栈打爆。32 足够覆盖任何合理
  // 的人类使用场景(2^32 = 40 亿个 pane)。
  const MAX_LAYOUT_DEPTH = 32

  const deserializeNode = (
    saved: SavedLayout,
    paneCwdAcc: Record<string, string>,
    paneWorkspaceRootAcc: Record<string, string>,
    paneTerminalAcc: Record<string, SavedTerminalState>,
    usedPaneIds: Set<string>,
    depth = 0
  ): LayoutNode => {
    if (depth >= MAX_LAYOUT_DEPTH || !saved || typeof saved !== 'object') {
      return { type: 'pane', id: newPaneId() }
    }
    if (saved.type === 'pane') {
      const id = isSavedPaneId(saved.id) && !usedPaneIds.has(saved.id) ? saved.id : newPaneId()
      usedPaneIds.add(id)
      if (saved.cwd && typeof saved.cwd === 'string') paneCwdAcc[id] = saved.cwd
      const workspaceRoot =
        saved.workspaceRoot && typeof saved.workspaceRoot === 'string'
          ? saved.workspaceRoot
          : saved.cwd
      if (workspaceRoot) paneWorkspaceRootAcc[id] = workspaceRoot
      if (
        saved.terminal &&
        saved.terminal.kind === 'ssh' &&
        typeof saved.terminal.profileId === 'string'
      ) {
        paneTerminalAcc[id] = { kind: 'ssh', profileId: saved.terminal.profileId }
      }
      return { type: 'pane', id }
    }
    // split 节点 — 校验子节点存在,否则当 pane 处理。
    if (saved.type !== 'split' || !saved.a || !saved.b) {
      return { type: 'pane', id: newPaneId() }
    }
    return {
      type: 'split',
      direction: saved.direction === 'column' ? 'column' : 'row',
      ratio:
        typeof saved.ratio === 'number' && saved.ratio > MIN_RATIO && saved.ratio < MAX_RATIO
          ? saved.ratio
          : 0.5,
      a: deserializeNode(
        saved.a,
        paneCwdAcc,
        paneWorkspaceRootAcc,
        paneTerminalAcc,
        usedPaneIds,
        depth + 1
      ),
      b: deserializeNode(
        saved.b,
        paneCwdAcc,
        paneWorkspaceRootAcc,
        paneTerminalAcc,
        usedPaneIds,
        depth + 1
      )
    }
  }

  const restoreFromSaved = (saved: SavedLayout | null | undefined): void => {
    if (saved) {
      try {
        const restoredPaneCwd: Record<string, string> = {}
        const restoredPaneWorkspaceRoot: Record<string, string> = {}
        const restoredPaneTerminal: Record<string, SavedTerminalState> = {}
        const restored = deserializeNode(
          saved,
          restoredPaneCwd,
          restoredPaneWorkspaceRoot,
          restoredPaneTerminal,
          new Set()
        )
        layout.value = restored
        paneCwd.value = restoredPaneCwd
        paneWorkspaceRoot.value = restoredPaneWorkspaceRoot
        paneTerminalState.value = restoredPaneTerminal
        activeId.value = firstLeafId(restored)
        return
      } catch {
        // 异常 saved 形状 —— fall through 到下面的默认单 pane。
      }
    }
    const firstId = newPaneId()
    layout.value = { type: 'pane', id: firstId }
    paneWorkspaceRoot.value = {}
    paneTerminalState.value = {}
    activeId.value = firstId
  }

  // ---- 全局事件注册 ------------------------------------------------------
  onMounted(() => {
    window.addEventListener('mousemove', onDividerMove)
    window.addEventListener('mouseup', onDividerUp)
    window.addEventListener('mousemove', onPaneDragMove)
    window.addEventListener('mouseup', onPaneDragUp)
    window.addEventListener('keydown', onPaneDragKey)
  })

  onUnmounted(() => {
    window.removeEventListener('mousemove', onDividerMove)
    window.removeEventListener('mouseup', onDividerUp)
    window.removeEventListener('mousemove', onPaneDragMove)
    window.removeEventListener('mouseup', onPaneDragUp)
    window.removeEventListener('keydown', onPaneDragKey)
  })

  return {
    layout,
    activeId,
    paneCwd,
    paneWorkspaceRoot,
    paneTerminalState,
    dragState,
    paneDrag,
    dropTarget,
    layoutResult,
    draggedRect,
    dropIndicatorRect,
    onSplit,
    onClose,
    onCreateWorktree,
    setActive,
    onCwdChange,
    onWorkspaceRootChange,
    focusNeighbor,
    onDividerDown,
    onDividerDoubleClick,
    onPaneDragStart,
    serializeLayout,
    restoreFromSaved
  }
}
