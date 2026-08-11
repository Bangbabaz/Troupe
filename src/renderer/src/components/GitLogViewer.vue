<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { RefreshCw, GitCommit, User, Calendar, Search } from 'lucide-vue-next'
import DiffViewer from './DiffViewer.vue'
import { computeGraph, GRAPH, laneCenterX } from '../lib/commitGraph'
import { splitDiffByFile, type FilePatch } from '../lib/gitDiffFiles'
import type { CommitInfo, CommitDetail, BranchInfo } from '@shared/types'

const props = defineProps<{ cwd: string }>()

// 默认页大小 50 —— 主进程那边的默认也是 50,这里再写一遍是因为加载更多也走
// 同一个常量,保持本组件的滚动节奏与首次加载一致。
const PAGE = 50

// --- list / detail state -------------------------------------------------
const commits = ref<CommitInfo[]>([])
const selectedHash = ref<string | null>(null)
const detail = ref<CommitDetail | null>(null)
const loadingList = ref(false)
const loadingMore = ref(false)
const loadingDetail = ref(false)
const hasMore = ref(true)

// --- filters -------------------------------------------------------------
const branches = ref<BranchInfo[]>([])
const branchFilter = ref<string>('') // empty = HEAD
const grepFilter = ref('')
const authorFilter = ref('')
// Debounced copies that actually drive the IPC call so each keystroke
// doesn't kick off a fresh git log.
const grepDebounced = ref('')
const authorDebounced = ref('')
let grepTimer: ReturnType<typeof setTimeout> | null = null
let authorTimer: ReturnType<typeof setTimeout> | null = null

watch(grepFilter, (v) => {
  if (grepTimer) clearTimeout(grepTimer)
  grepTimer = setTimeout(() => {
    grepDebounced.value = v
  }, 280)
})
watch(authorFilter, (v) => {
  if (authorTimer) clearTimeout(authorTimer)
  authorTimer = setTimeout(() => {
    authorDebounced.value = v
  }, 280)
})

// --- splitter sizes ------------------------------------------------------
// Stored as px so resize math is independent of the surrounding layout. The
// ResizeObserver below clamps them back into the container's actual bounds
// whenever the dialog itself is resized.
const sidebarW = ref(360)
// `bodyH` covers the entire bottom band on the right side: subject + body +
// the two compact metadata lines (hash/parents and author/time). The old
// separately-resizable meta band was removed — the bottom rows are just a
// fixed-style footer inside the body band now.
const bodyH = ref(180)
const filesW = ref(260)

const bodyRef = ref<HTMLElement>()
const rightRef = ref<HTMLElement>()
const filesDiffRef = ref<HTMLElement>()

// Min/max constants — tight enough that the user can't make a pane unusably
// small but loose enough that a small dialog still leaves a useful diff area.
const MIN_SIDEBAR = 220
const MAX_SIDEBAR_FRAC = 0.65
const MIN_BODY = 80
const MAX_BODY_FRAC = 0.6
const MIN_FILES = 160
const MAX_FILES_FRAC = 0.6

// Drag targets:
//   sidebar — commits list ↔ right panel (horizontal axis)
//   files   — files list ↔ diff content (horizontal axis)
//   body    — files+diff ↔ commit-message-and-meta band (vertical, INVERTED:
//             drag down shrinks the body so files+diff grows)
interface DragState {
  axis: 'x' | 'y'
  startCoord: number
  startVal: number
  target: 'sidebar' | 'body' | 'files'
  containerSize: number
  /** Vertical splitters above a fixed-height band invert their sign — dragging
   *  the splitter down shrinks the band below it. */
  invert: boolean
}
let drag: DragState | null = null
let previousBodyCursor = ''
let previousBodyUserSelect = ''

function startDrag(e: MouseEvent, target: DragState['target']): void {
  e.preventDefault()
  onDragEnd()
  const axis: 'x' | 'y' = target === 'body' ? 'y' : 'x'
  let containerEl: HTMLElement | undefined
  let startVal = 0
  if (target === 'sidebar') {
    containerEl = bodyRef.value
    startVal = sidebarW.value
  } else if (target === 'body') {
    containerEl = rightRef.value
    startVal = bodyH.value
  } else {
    containerEl = filesDiffRef.value
    startVal = filesW.value
  }
  if (!containerEl) return
  const rect = containerEl.getBoundingClientRect()
  drag = {
    axis,
    startCoord: axis === 'x' ? e.clientX : e.clientY,
    startVal,
    target,
    containerSize: axis === 'x' ? rect.width : rect.height,
    invert: axis === 'y'
  }
  previousBodyCursor = document.body.style.cursor
  previousBodyUserSelect = document.body.style.userSelect
  document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
  window.addEventListener('blur', onDragEnd)
}

function clampSplitter(target: DragState['target'], val: number, container: number): number {
  if (target === 'sidebar') {
    return Math.max(MIN_SIDEBAR, Math.min(container * MAX_SIDEBAR_FRAC, val))
  }
  if (target === 'body') {
    return Math.max(MIN_BODY, Math.min(container * MAX_BODY_FRAC, val))
  }
  return Math.max(MIN_FILES, Math.min(container * MAX_FILES_FRAC, val))
}

function onDragMove(e: MouseEvent): void {
  if (!drag) return
  const delta = (drag.axis === 'x' ? e.clientX : e.clientY) - drag.startCoord
  const sign = drag.invert ? -1 : 1
  const next = clampSplitter(drag.target, drag.startVal + sign * delta, drag.containerSize)
  if (drag.target === 'sidebar') sidebarW.value = next
  else if (drag.target === 'body') bodyH.value = next
  else filesW.value = next
}

function onDragEnd(): void {
  if (!drag) return
  drag = null
  document.body.style.cursor = previousBodyCursor
  document.body.style.userSelect = previousBodyUserSelect
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  window.removeEventListener('blur', onDragEnd)
}

// Keep splitter sizes valid when the dialog itself is resized (or the layout
// initialises before its parent had a real height).
let bodyRo: ResizeObserver | null = null
let rightRo: ResizeObserver | null = null
let filesDiffRo: ResizeObserver | null = null

onMounted(async () => {
  await nextTick()
  if (bodyRef.value) {
    bodyRo = new ResizeObserver(() => {
      const w = bodyRef.value!.getBoundingClientRect().width
      sidebarW.value = clampSplitter('sidebar', sidebarW.value, w)
    })
    bodyRo.observe(bodyRef.value)
  }
  if (rightRef.value) {
    rightRo = new ResizeObserver(() => {
      const h = rightRef.value!.getBoundingClientRect().height
      bodyH.value = clampSplitter('body', bodyH.value, h)
    })
    rightRo.observe(rightRef.value)
  }
  if (filesDiffRef.value) {
    filesDiffRo = new ResizeObserver(() => {
      const w = filesDiffRef.value!.getBoundingClientRect().width
      filesW.value = clampSplitter('files', filesW.value, w)
    })
    filesDiffRo.observe(filesDiffRef.value)
  }
})

onUnmounted(() => {
  bodyRo?.disconnect()
  rightRo?.disconnect()
  filesDiffRo?.disconnect()
  onDragEnd()
})

// --- data fetching -------------------------------------------------------

let listGen = 0
let detailGen = 0

async function loadInitial(): Promise<void> {
  if (!props.cwd) return
  loadingList.value = true
  hasMore.value = true
  commits.value = []
  selectedHash.value = null
  detail.value = null
  const myGen = ++listGen
  try {
    const list = await window.api.gitLog(props.cwd, {
      skip: 0,
      limit: PAGE,
      ref: branchFilter.value || undefined,
      grep: grepDebounced.value || undefined,
      author: authorDebounced.value || undefined
    })
    if (myGen !== listGen) return
    commits.value = list
    hasMore.value = list.length === PAGE
    if (list.length) {
      selectedHash.value = list[0].hash
      loadDetail(list[0].hash)
    }
    // 不 await:branches 信息独立于主列表渲染,异步注入避免 ~0.5-1s 的 rev-list
    // 卡住 commits 显示。
    void loadBranchesForCommits(
      list.map((c) => c.hash),
      myGen
    )
  } catch {
    if (myGen === listGen) commits.value = []
  } finally {
    if (myGen === listGen) loadingList.value = false
  }
}

async function loadMore(): Promise<void> {
  if (!props.cwd || !hasMore.value || loadingMore.value) return
  loadingMore.value = true
  const myGen = listGen
  try {
    const list = await window.api.gitLog(props.cwd, {
      skip: commits.value.length,
      limit: PAGE,
      ref: branchFilter.value || undefined,
      grep: grepDebounced.value || undefined,
      author: authorDebounced.value || undefined
    })
    if (myGen !== listGen) return
    commits.value = [...commits.value, ...list]
    if (list.length < PAGE) hasMore.value = false
    void loadBranchesForCommits(
      list.map((c) => c.hash),
      myGen
    )
  } finally {
    loadingMore.value = false
  }
}

/**
 * 异步算这一批 commits 各自被哪些分支包含,合并回 commits.value。listGen 比对
 * 保护:用户切换 cwd / branch filter / grep 时 generation 已经++,老调用回来
 * 不能污染新列表。失败静默 —— commits 主功能不依赖 branches。
 */
async function loadBranchesForCommits(hashes: string[], myGen: number): Promise<void> {
  if (!hashes.length) return
  try {
    const map = await window.api.gitCommitBranches(props.cwd, hashes)
    if (myGen !== listGen) return
    const toMerge = new Set(hashes)
    commits.value = commits.value.map((c) =>
      toMerge.has(c.hash) ? { ...c, branches: map[c.hash] || [] } : c
    )
  } catch {
    // 静默 —— 主功能不受影响
  }
}

async function loadDetail(hash: string): Promise<void> {
  if (!props.cwd) return
  loadingDetail.value = true
  detail.value = null
  selectedFileIdx.value = 0
  const myGen = ++detailGen
  try {
    const d = await window.api.gitCommitDetail(props.cwd, hash)
    if (myGen !== detailGen) return
    if (!d) {
      ElMessage.error('未能读取该提交')
      return
    }
    detail.value = d
  } finally {
    if (myGen === detailGen) loadingDetail.value = false
  }
}

async function loadBranches(): Promise<void> {
  if (!props.cwd) return
  try {
    branches.value = await window.api.getGitBranches(props.cwd)
  } catch {
    branches.value = []
  }
}

function selectCommit(c: CommitInfo, event: MouseEvent): void {
  const selection = window.getSelection()
  const row = event.currentTarget as HTMLElement | null
  if (
    event.detail > 0 &&
    selection &&
    !selection.isCollapsed &&
    row &&
    ((selection.anchorNode && row.contains(selection.anchorNode)) ||
      (selection.focusNode && row.contains(selection.focusNode)))
  ) {
    return
  }
  if (c.hash === selectedHash.value) return
  selectedHash.value = c.hash
  loadDetail(c.hash)
}

// --- 提交图 -------------------------------------------------------------
// commits 变化 → 重算 graph 数据;每行的圆点 + 上下连线由 GRAPH 常量统一控制。
const graphRows = computed(() => computeGraph(commits.value))

// 所有行共用相同 graph 列宽 —— 否则 commit subject 列的左边缘会摇摆。
// width = max(laneCount across all rows) * laneStep + 2 * leftPad。宽度必须
// 与实际 lane 一致，否则超出固定上限的 SVG 会覆盖右侧提交信息。
const graphWidth = computed(() => {
  let maxLanes = 1
  for (const r of graphRows.value) {
    if (r.laneCount > maxLanes) maxLanes = r.laneCount
  }
  return GRAPH.leftPad * 2 + (maxLanes - 1) * GRAPH.laneStep
})
const graphHeight = GRAPH.rowHeight

watch(
  () => props.cwd,
  () => {
    loadBranches()
    loadInitial()
  },
  { immediate: true }
)

// Re-fetch when any of the three filters changes (debounced ones via their
// `*Debounced` ref so we don't kick on every keystroke).
watch([branchFilter, grepDebounced, authorDebounced], () => loadInitial())

defineExpose({ refresh: loadInitial })

// --- file splitting ------------------------------------------------------
// Slice the unified patch into per-file pieces by walking line by line and
// breaking on `diff --git a/... b/...` headers. Cheaper than re-parsing
// diff2html's output back into a string, and keeps the original git format
// (with /dev/null markers, mode lines, binary deltas) intact for the
// right-side DiffViewer.
const filePatches = computed<FilePatch[]>(() => splitDiffByFile(detail.value?.diff || ''))
const selectedFileIdx = ref(0)
const selectedPatch = computed(() => filePatches.value[selectedFileIdx.value]?.body || '')

// DiffViewer 拉取整文件做语法高亮。commit diff：
// 左侧 = commit~（父 commit 版本），右侧 = commit 版本。
// 父 commit 不存在（root commit）时 git show 失败，gitShowFile 返回 null，DiffViewer 自动 fallback。
function fetchDiffContent(side: 'old' | 'new', path: string): Promise<string | null> {
  const d = detail.value
  if (!d) return Promise.resolve(null)
  return window.api.gitShowFile(props.cwd, side === 'old' ? `${d.hash}^` : d.hash, path)
}

// --- display helpers -----------------------------------------------------

function formatDate(iso: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const diff = (Date.now() - t) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86_400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)} 天前`
  return iso.slice(0, 10)
}

function formatFullDate(iso: string): string {
  if (!iso) return ''
  return iso.replace(/:\d{2}([+-]\d{2}:\d{2}|Z)$/, '$1')
}

type Decoration = { kind: 'head' | 'branch' | 'remote' | 'tag'; label: string }

/**
 * 把 commit.refs 里展示过的分支名归一成 Set,供 extraBranches 做差集 ——
 * 'HEAD -> main' 拆出 'main';'tag: x'/'HEAD'/'origin/HEAD' 不算分支跳过。
 * 这样"包含于"那一行不会和顶上 decoration 标签里已经亮的分支重复显示。
 */
function refsAsBranchSet(refs: string[]): Set<string> {
  const set = new Set<string>()
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) set.add(r.slice('HEAD -> '.length))
    else if (r.startsWith('tag: ')) continue
    else if (r === 'HEAD') continue
    else if (/\/HEAD$/.test(r)) continue
    else set.add(r)
  }
  return set
}

function extraBranches(c: CommitInfo): string[] {
  if (!c.branches?.length) return []
  const ignore = refsAsBranchSet(c.refs)
  return c.branches.filter((b) => !ignore.has(b))
}

function decorate(refs: string[]): Decoration[] {
  const out: Decoration[] = []
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) {
      out.push({ kind: 'head', label: 'HEAD' })
      out.push({ kind: 'branch', label: r.slice('HEAD -> '.length) })
    } else if (r === 'HEAD') {
      out.push({ kind: 'head', label: 'HEAD' })
    } else if (r.startsWith('tag: ')) {
      out.push({ kind: 'tag', label: r.slice('tag: '.length) })
    } else if (r.includes('/')) {
      out.push({ kind: 'remote', label: r })
    } else {
      out.push({ kind: 'branch', label: r })
    }
  }
  return out
}

const branchOptions = computed(() => {
  const opts: { value: string; label: string; group: 'local' | 'remote' }[] = []
  for (const b of branches.value) {
    if (b.local) opts.push({ value: b.name, label: b.name, group: 'local' })
  }
  for (const b of branches.value) {
    if (b.remote && !b.local) {
      const ref = `${b.remoteName || 'origin'}/${b.name}`
      opts.push({ value: ref, label: ref, group: 'remote' })
    }
  }
  return opts
})

const fileStatusLabel = (s: FilePatch['status']): string =>
  s === 'new'
    ? '新增'
    : s === 'deleted'
      ? '删除'
      : s === 'renamed'
        ? '重命名'
        : s === 'binary'
          ? '二进制'
          : '修改'
</script>

<template>
  <div class="gl-root">
    <header class="gl-header">
      <el-select
        v-model="branchFilter"
        size="small"
        filterable
        clearable
        class="gl-branch-select"
        placeholder="所有分支（HEAD）"
      >
        <el-option value="" label="所有分支（HEAD）" />
        <el-option-group label="本地分支">
          <el-option
            v-for="o in branchOptions.filter((x) => x.group === 'local')"
            :key="`l:${o.value}`"
            :value="o.value"
            :label="o.label"
          />
        </el-option-group>
        <el-option-group label="远程分支">
          <el-option
            v-for="o in branchOptions.filter((x) => x.group === 'remote')"
            :key="`r:${o.value}`"
            :value="o.value"
            :label="o.label"
          />
        </el-option-group>
      </el-select>
      <el-input
        v-model="grepFilter"
        size="small"
        clearable
        class="gl-filter-input"
        placeholder="提交信息过滤"
      >
        <template #prefix>
          <Search :size="12" />
        </template>
      </el-input>
      <el-input
        v-model="authorFilter"
        size="small"
        clearable
        class="gl-filter-input"
        placeholder="作者过滤"
      >
        <template #prefix>
          <User :size="12" />
        </template>
      </el-input>
      <button class="gl-refresh" :disabled="loadingList" title="刷新" @click="loadInitial">
        <RefreshCw :size="13" />
      </button>
    </header>

    <div ref="bodyRef" class="gl-body">
      <aside class="gl-sidebar" :style="{ width: sidebarW + 'px' }">
        <div v-if="loadingList && !commits.length" class="gl-state">加载中…</div>
        <div v-else-if="!commits.length" class="gl-state">没有匹配的提交</div>
        <template v-else>
          <button
            v-for="(c, idx) in commits"
            :key="c.hash"
            class="gl-row"
            :class="{ active: c.hash === selectedHash }"
            @click="selectCommit(c, $event)"
          >
            <!-- graph 单元:lane 圆点 + 上下连线。同行所有 SVG 宽度都用
                 graphWidth(max over rows),保证 commit 内容列对齐。 -->
            <!-- 包一层 cell:cell 走 align-self: stretch 跟 row 等高,SVG 在
                 cell 内 absolute 定位 + height:100% —— 这样 SVG 不撑高 row
                 (absolute 脱离布局,SVG 没 viewBox 默认 height 150px 不会反过
                 来把 row 拉高),圆点 cy=18 仍对齐 subject 行视觉中心,底段
                 y2="100%" 拉到 row 底,与下一个 SVG 的顶段 y=0 无缝接续。 -->
            <div v-if="graphRows[idx]" class="gl-graph-cell" :style="{ width: graphWidth + 'px' }">
              <svg class="gl-graph" :width="graphWidth" height="100%">
                <line
                  v-for="(s, si) in graphRows[idx].topSegments"
                  :key="`t${si}`"
                  :x1="laneCenterX(s.fromLane)"
                  :y1="0"
                  :x2="laneCenterX(s.toLane)"
                  :y2="graphHeight / 2"
                  :stroke="s.color"
                  stroke-width="1.5"
                />
                <line
                  v-for="(s, si) in graphRows[idx].bottomSegments"
                  :key="`b${si}`"
                  :x1="laneCenterX(s.fromLane)"
                  :y1="graphHeight / 2"
                  :x2="laneCenterX(s.toLane)"
                  y2="100%"
                  :stroke="s.color"
                  stroke-width="1.5"
                />
                <!-- merge commit:空心圆 + 加粗描边表达"合并节点";普通 commit
                     实心圆 —— 一眼区分 merge / 普通。 -->
                <circle
                  :cx="laneCenterX(graphRows[idx].ownLane)"
                  :cy="graphHeight / 2"
                  :r="GRAPH.dotRadius"
                  :fill="graphRows[idx].isMerge ? 'var(--el-bg-color)' : graphRows[idx].dotColor"
                  :stroke="graphRows[idx].dotColor"
                  :stroke-width="graphRows[idx].isMerge ? 2 : 1"
                />
              </svg>
            </div>
            <div class="gl-row-body">
              <div class="gl-row-top">
                <span class="gl-subject" :title="c.subject">{{ c.subject }}</span>
              </div>
              <div class="gl-row-meta">
                <span class="gl-hash">{{ c.shortHash }}</span>
                <span class="gl-author">{{ c.author }}</span>
                <span class="gl-date" :title="c.date">{{ formatDate(c.date) }}</span>
              </div>
              <div v-if="c.refs.length" class="gl-row-refs">
                <span
                  v-for="(d, i) in decorate(c.refs)"
                  :key="i"
                  class="gl-ref"
                  :class="`gl-ref-${d.kind}`"
                  :title="d.label"
                  >{{ d.label }}</span
                >
              </div>
              <div v-if="extraBranches(c).length" class="gl-row-branches">
                <span class="gl-branches-label">包含于</span>
                <span
                  v-for="b in extraBranches(c)"
                  :key="b"
                  class="gl-ref gl-ref-contained"
                  :title="b"
                  >{{ b }}</span
                >
              </div>
            </div>
          </button>
          <button v-if="hasMore" class="gl-load-more" :disabled="loadingMore" @click="loadMore">
            {{ loadingMore ? '加载中…' : `加载更多(已加载 ${commits.length})` }}
          </button>
        </template>
      </aside>

      <div class="gl-splitter-h" @mousedown="(e) => startDrag(e, 'sidebar')" />

      <section ref="rightRef" class="gl-right">
        <!-- Top band (flex 1): file list ⇆ diff. The diff is the visual
             centre of gravity, so we give it the bulk of the right column. -->
        <div ref="filesDiffRef" class="gl-files-diff">
          <aside class="gl-files" :style="{ width: filesW + 'px' }">
            <div class="gl-files-title">
              改动文件（{{ filePatches.length }}）
              <span v-if="detail?.truncated" class="gl-trunc-inline">（截断）</span>
            </div>
            <button
              v-for="(f, i) in filePatches"
              :key="i"
              class="gl-file-item"
              :class="{ active: i === selectedFileIdx }"
              @click="selectedFileIdx = i"
            >
              <span class="gl-file-badge" :class="`fs-${f.status}`">{{
                fileStatusLabel(f.status)
              }}</span>
              <span class="gl-file-name" :title="f.path">{{ f.path }}</span>
              <span class="gl-file-counts">
                <span v-if="f.added" class="gl-add">+{{ f.added }}</span>
                <span v-if="f.deleted" class="gl-del">−{{ f.deleted }}</span>
              </span>
            </button>
            <div v-if="!filePatches.length && detail && !loadingDetail" class="gl-state">
              该提交无文本改动
            </div>
          </aside>

          <div class="gl-splitter-h" @mousedown="(e) => startDrag(e, 'files')" />

          <div class="gl-diff">
            <DiffViewer
              v-if="selectedPatch && detail"
              :diff="selectedPatch"
              hide-sidebar
              :fetch-content="fetchDiffContent"
            />
            <div v-else-if="detail && !filePatches.length" class="gl-state">该提交无文本改动</div>
          </div>
        </div>

        <div class="gl-splitter-v" @mousedown="(e) => startDrag(e, 'body')" />

        <!-- Bottom band: subject + body + compact meta footer. Single
             resizable section; the splitter above controls its height. -->
        <div class="gl-body-msg" :style="{ height: bodyH + 'px' }">
          <div v-if="loadingDetail" class="gl-state">加载提交详情…</div>
          <template v-else-if="detail">
            <div class="gl-detail-subject">{{ detail.subject }}</div>
            <pre v-if="detail.body" class="gl-detail-body">{{ detail.body }}</pre>
            <div v-else class="gl-no-body">（无附加说明）</div>

            <!-- Compact two-line footer below the message. Line 1: current
                 commit + parents (the "graph position" — what this commit IS
                 and where it came from). Line 2: author + date (the "who
                 and when"). Refs piggy-back as a third row when present. -->
            <div class="gl-meta-rows">
              <div class="gl-meta-line">
                <span class="gl-detail-row">
                  <GitCommit :size="12" />
                  <code>{{ detail.shortHash }}</code>
                </span>
                <span v-if="detail.parents.length" class="gl-detail-row">
                  <span class="gl-detail-label">父提交</span>
                  <code v-for="p in detail.parents" :key="p" class="gl-parent">{{
                    p.slice(0, 7)
                  }}</code>
                </span>
              </div>
              <div class="gl-meta-line">
                <span class="gl-detail-row">
                  <User :size="12" />
                  {{ detail.author }} &lt;{{ detail.email }}&gt;
                </span>
                <span class="gl-detail-row">
                  <Calendar :size="12" />
                  {{ formatFullDate(detail.date) }}
                </span>
              </div>
              <div v-if="detail.refs.length" class="gl-detail-refs">
                <span
                  v-for="(d, i) in decorate(detail.refs)"
                  :key="i"
                  class="gl-ref"
                  :class="`gl-ref-${d.kind}`"
                  >{{ d.label }}</span
                >
              </div>
            </div>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
// 共用的可点击行外观（commit row / file item） —— 透明底 + 透明描边 + hover 填充 +
// active 高亮。保持视觉一致，但每个列表的间距/字号/排版仍各自定义。
%clickable-row {
  background: transparent;
  border: 1px solid transparent;
  border-radius: $radius-sm;
  cursor: pointer;
  text-align: left;

  &:hover {
    background: var(--el-fill-color);
  }

  &.active {
    background: var(--el-color-primary-light-9);
    border-color: color-mix(in srgb, var(--el-color-primary) 35%, transparent);
  }
}

// 等宽小代码块（hash / parent / inline code）。
%mono-chip {
  @include mono-font;
  background: var(--el-fill-color);
  padding: 1px 6px;
  border-radius: $radius-sm;
  font-size: 11px;
}

// splitter 公共部分：4px 命中区 + ::after 描出 1px 实线，hover 变蓝。
%splitter-base {
  flex-shrink: 0;
  background: transparent;
  position: relative;
  transition: background 0.12s;

  &::after {
    content: '';
    position: absolute;
    background: var(--el-border-color);
  }

  &:hover::after {
    background: var(--el-color-primary);
  }
}

.gl-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 14px 16px;
  @include ui-font;
  overflow: hidden;
  user-select: text;
}

.gl-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 10px;
  border-bottom: 1px solid var(--el-border-color);
  flex-shrink: 0;
}

.gl-branch-select {
  width: 240px;
  flex-shrink: 0;
}

.gl-filter-input {
  flex: 1;
  min-width: 0;
  max-width: 280px;
}

.gl-refresh {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--el-border-color);
  border-radius: $radius-sm;
  color: var(--el-text-color-regular);
  margin-left: auto;
  flex-shrink: 0;

  &:hover:not(:disabled) {
    background: var(--el-fill-color);
    color: var(--el-color-primary);
    border-color: var(--el-text-color-secondary);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.gl-body {
  flex: 1;
  display: flex;
  min-height: 0;
  margin-top: 10px;
}

.gl-state {
  padding: 24px 12px;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  text-align: center;
}

.gl-sidebar {
  flex-shrink: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-right: 4px;
  min-width: 0;
}

.gl-row {
  @extend %clickable-row;
  display: flex;
  flex-shrink: 0;
  align-items: stretch;
  gap: 6px;
  width: 100%;
  min-height: 36px;
  padding: 0 8px 0 0;
  border: 0;
  user-select: text;

  &.active {
    border: 0;
  }
}

// graph cell 走 align-self: stretch 跟 row 等高;SVG 绝对定位 + height 100%
// 跟 cell 等高 —— 不撑高 row(否则 SVG 没 viewBox 时浏览器会用 default 150px
// 内 height 解析,反过来把整行拉到 150px)。overflow: visible 防 1.5 stroke
// 在 SVG 边界被裁。
.gl-graph-cell {
  flex-shrink: 0;
  align-self: stretch;
  position: relative;
  user-select: none;
  pointer-events: none;
}

.gl-graph {
  display: block;
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
}

.gl-row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 2px 0;
}

.gl-row-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.gl-subject {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--el-text-color-primary);
  font-weight: 500;
  @include ellipsis;
}

.gl-row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.gl-hash {
  @include mono-font;
  color: var(--el-color-warning);
}

.gl-author {
  flex: 1;
  min-width: 0;
  @include ellipsis;
}

.gl-date {
  flex-shrink: 0;
}

.gl-row-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

// "包含于"那一行 —— 列出 ref decoration 没出现的分支(本 commit 是哪些分支的祖先)。
// 比 decoration 弱化:用 fill 灰底 + secondary text,不抢主行的视觉重点。
.gl-row-branches {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.gl-branches-label {
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  letter-spacing: 0;
}

.gl-ref {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: $radius-sm;
  @include mono-font;
  line-height: 1.4;
  @include ellipsis;
  max-width: 200px;

  &.gl-ref-head {
    background: color-mix(in srgb, var(--el-color-warning) 22%, transparent);
    color: var(--el-color-warning);
    font-weight: 600;
  }

  &.gl-ref-branch {
    background: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
  }

  &.gl-ref-remote {
    background: color-mix(in srgb, var(--el-color-info) 18%, transparent);
    color: var(--el-color-info);
  }

  &.gl-ref-tag {
    background: color-mix(in srgb, var(--el-color-success) 18%, transparent);
    color: var(--el-color-success);
  }

  &.gl-ref-contained {
    background: var(--el-fill-color);
    color: var(--el-text-color-secondary);
  }
}

.gl-load-more {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 4px;
  padding: 6px 8px;
  background: var(--el-fill-color);
  border: 1px dashed var(--el-border-color);
  border-radius: $radius-sm;
  color: var(--el-text-color-secondary);
  font-size: 12px;

  &:hover:not(:disabled) {
    background: var(--el-fill-color-darker);
    color: var(--el-color-primary);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

/* Vertical splitter (between left list and right pane / between file list and diff). */
.gl-splitter-h {
  @extend %splitter-base;
  width: 4px;
  cursor: col-resize;

  &::after {
    inset: 0 1px;
  }
}

/* Horizontal splitter (between meta and files+diff). */
.gl-splitter-v {
  @extend %splitter-base;
  height: 4px;
  cursor: row-resize;

  &::after {
    inset: 1px 0;
  }
}

.gl-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Bottom band: subject + body + compact meta footer. Single resizable
   section controlled by the `body` splitter; scrolls internally when the
   body overflows. */
.gl-body-msg {
  flex-shrink: 0;
  overflow-y: auto;
  padding: 8px 12px;
  min-height: 0;
}

/* Compact meta footer: parents+hash on one line, author+date on the next.
   `flex-wrap: wrap` keeps it readable when the dialog is narrow — the
   `<span>` rows reflow rather than truncate. */
.gl-meta-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color);
}

.gl-meta-line {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  row-gap: 4px;
}

.gl-no-body {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  font-style: italic;
}

.gl-detail-subject {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin: 4px 0 8px;
}

.gl-detail-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  flex-wrap: wrap;

  code {
    @extend %mono-chip;
  }
}

.gl-detail-label {
  color: var(--el-text-color-secondary);
}

.gl-parent {
  @extend %mono-chip;
}

.gl-detail-body {
  margin: 8px 0 0;
  padding: 8px 12px;
  background: var(--el-fill-color-lighter);
  border-left: 3px solid var(--el-color-info);
  border-radius: $radius-sm;
  @include mono-font;
  font-size: 12px;
  color: var(--el-text-color-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
}

.gl-detail-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.gl-files-diff {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.gl-files {
  flex-shrink: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 4px 8px 8px;
  min-width: 0;
}

.gl-files-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--el-text-color-secondary);
  padding: 0 8px 6px;
}

.gl-trunc-inline {
  color: var(--el-color-warning);
  font-weight: 400;
  letter-spacing: 0;
}

.gl-file-item {
  @extend %clickable-row;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
}

.gl-file-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: $radius-sm;
  flex-shrink: 0;

  &.fs-new {
    color: color-mix(in srgb, var(--el-color-success) 75%, var(--el-text-color-primary));
    background: var(--el-color-success-light-8);
  }

  &.fs-deleted {
    color: color-mix(in srgb, var(--el-color-danger) 75%, var(--el-text-color-primary));
    background: var(--el-color-danger-light-8);
  }

  &.fs-renamed {
    color: var(--el-color-warning);
    background: var(--el-color-warning-light-8);
  }

  &.fs-modified {
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
  }

  &.fs-binary {
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color);
  }
}

.gl-file-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  @include mono-font;
  color: var(--el-text-color-primary);
  @include ellipsis;
}

.gl-file-counts {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  font-size: 11px;
}

.gl-add {
  color: color-mix(in srgb, var(--el-color-success) 75%, var(--el-text-color-primary));
}

.gl-del {
  color: color-mix(in srgb, var(--el-color-danger) 75%, var(--el-text-color-primary));
}

.gl-diff {
  flex: 1;
  min-width: 0;
  overflow: auto;
}
</style>
