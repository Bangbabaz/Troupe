<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { parse } from 'diff2html'
import { LineType } from 'diff2html/lib-esm/types'
import { decodeGitPath } from '../lib/gitDiffFiles'
import { detectFileLanguage } from '../lib/fileLanguage'
import ShikiWorker from '../workers/shiki.worker?worker'

const props = defineProps<{
  diff: string
  /**
   * Hide the built-in file list. Used when the parent (e.g. GitLogViewer) owns
   * its own file-picker and only wants the right-hand diff grid rendered.
   */
  hideSidebar?: boolean
  /**
   * 拉取某一侧文件的完整内容用于整文件级语法高亮。
   *   - `side`: 'old' 对应 diff 左侧（删除前），'new' 对应右侧（修改后）
   *   - `path`: diff 解析出的对应文件路径（oldName / newName）
   *   - 返回 null 表示该侧不可用（二进制 / 删除 / 找不到），DiffViewer 自动 fallback 到无高亮
   *
   * 缺省时整个 DiffViewer 走无高亮纯文本（仍可读，只是没颜色）。
   */
  fetchContent?: (side: 'old' | 'new', path: string) => Promise<string | null>
}>()

type CellKind = 'ctx' | 'del' | 'ins' | 'empty'
type Cell = { num: number | null; text: string; kind: CellKind }
type Row = { kind: 'hunk'; text: string } | { kind: 'pair'; left: Cell; right: Cell }

type FileView = {
  id: string
  name: string
  oldName: string | null
  newName: string | null
  status: string
  statusClass: string
  added: number
  deleted: number
  rows: Row[]
  binary: boolean
  lang: string | null
}

const DEV_NULL = new Set(['dev/null', '/dev/null'])

// shiki 在 Web Worker 里跑（src/renderer/src/workers/shiki.worker.ts），主线程
// 零阻塞 —— codeToHtml 是同步 CPU 密集操作，放在主线程会让 el-dialog 的进入
// 动画掉帧（用户感受就是"打开 diff 弹窗卡一下"）。
//
// 每个 DiffViewer 实例独占一个 worker —— `<script setup>` 顶层代码每次实例化
// 都会跑,如果不 terminate,反复开关 diff/commit-history/merge 弹窗会把旧 worker
// 留在内存(每个携带 highlighter + grammars + themes,几 MB 起)。在
// onBeforeUnmount 里 terminate,并拒绝 pending 请求避免回调挂死。
const worker = new ShikiWorker()
let nextReqId = 0
const pending = new Map<number, (lines: string[] | null) => void>()
let workerAlive = true
let stopActiveDrag: (() => void) | null = null

worker.addEventListener('message', (e: MessageEvent<{ id: number; lines: string[] | null }>) => {
  const { id, lines } = e.data
  const resolve = pending.get(id)
  if (resolve) {
    pending.delete(id)
    resolve(lines)
  }
})

function workerTokenize(content: string, lang: string): Promise<string[] | null> {
  if (!workerAlive) return Promise.resolve(null)
  return new Promise((resolve) => {
    const id = ++nextReqId
    pending.set(id, resolve)
    worker.postMessage({ id, content, lang })
  })
}

onBeforeUnmount(() => {
  stopActiveDrag?.()
  workerAlive = false
  // 在 terminate 前把残留 resolver 全部 resolve(null),避免 watch 里的
  // `await tokenizeFile` 永久挂起 —— 组件已经在销毁,被 await 的代码不会再
  // 写状态,但 Promise 漏掉 settle 仍然会让闭包持有 closure 内的 fs 引用。
  for (const resolve of pending.values()) resolve(null)
  pending.clear()
  worker.terminate()
})

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 整文件 → 按行 HTML 数组。worker 直接返回每行的 token span 字符串，
// 主线程拿到就能 v-html，零 DOM 解析开销。
//
// 每个 token <span> 同时带 dark 颜色（inline color）和 light 颜色（--shiki-light
// CSS 变量），主题切换走全局 CSS 不再回 worker。
function tokenizeFile(content: string, lang: string): Promise<string[] | null> {
  return workerTokenize(content, lang)
}

// diff2html 把 +/-/space 前缀放在每行 content 第一个字符。
function stripPrefix(s: string): string {
  return s.length ? s.slice(1) : s
}

const files = computed<FileView[]>(() => {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(props.diff)
  } catch {
    return []
  }
  return parsed.map((f, idx) => {
    const [status, statusClass] = f.isNew
      ? ['新增', 'st-new']
      : f.isDeleted
        ? ['删除', 'st-del']
        : f.isCopy
          ? ['复制', 'st-ren']
          : f.isRename
            ? ['重命名', 'st-ren']
            : f.isBinary
              ? ['二进制', 'st-mod']
              : ['修改', 'st-mod']

    const oldN = f.oldName && !DEV_NULL.has(f.oldName) ? decodeGitPath(f.oldName) : ''
    const newN = f.newName && !DEV_NULL.has(f.newName) ? decodeGitPath(f.newName) : ''
    let name = newN || oldN
    if ((f.isRename || f.isCopy) && oldN && newN && oldN !== newN) name = `${oldN} → ${newN}`
    else if (f.isDeleted) name = oldN || newN

    const rows: Row[] = []
    for (const block of f.blocks) {
      rows.push({ kind: 'hunk', text: block.header })
      const lines = block.lines
      let i = 0
      while (i < lines.length) {
        const ln = lines[i]
        if (ln.type === LineType.CONTEXT) {
          const text = stripPrefix(ln.content)
          rows.push({
            kind: 'pair',
            left: { num: ln.oldNumber ?? null, text, kind: 'ctx' },
            right: { num: ln.newNumber ?? null, text, kind: 'ctx' }
          })
          i++
        } else {
          const dels: typeof lines = []
          const ins: typeof lines = []
          while (i < lines.length && lines[i].type === LineType.DELETE) dels.push(lines[i++])
          while (i < lines.length && lines[i].type === LineType.INSERT) ins.push(lines[i++])
          const n = Math.max(dels.length, ins.length)
          for (let k = 0; k < n; k++) {
            const d = dels[k]
            const a = ins[k]
            rows.push({
              kind: 'pair',
              left: d
                ? { num: d.oldNumber ?? null, text: stripPrefix(d.content), kind: 'del' }
                : { num: null, text: '', kind: 'empty' },
              right: a
                ? { num: a.newNumber ?? null, text: stripPrefix(a.content), kind: 'ins' }
                : { num: null, text: '', kind: 'empty' }
            })
          }
        }
      }
    }

    return {
      id: `dvf-${idx}`,
      name,
      oldName: oldN || null,
      newName: newN || null,
      status,
      statusClass,
      added: f.addedLines,
      deleted: f.deletedLines,
      rows,
      binary: !!f.isBinary,
      lang: detectFileLanguage(name)
    }
  })
})

// 每个文件的整文件高亮结果（按行 HTML）。fetchContent 没提供 / 拉取失败 / 文件为二进制时
// 对应侧为 null，渲染时 fallback 到 escape 后的原文。
const highlighted = ref(new Map<string, { old: string[] | null; new: string[] | null }>())

// 每次 files 变化（即 props.diff 变化）都启动新一轮高亮。
// gen 用来在 async 完成时丢弃过期结果，避免快速切换 diff 时旧结果污染新视图。
let gen = 0

// 并发上限。大 PR / commit 可能有数百文件,如果对每个文件起独立 async,
// 一次性发上千个 IPC + shiki worker 任务,IPC 通道拥塞,worker 队列爆,主线程
// 反而被 message handler 卡住。串行调度,固定窗口数同时跑 —— 视区内的文件
// 优先(按 files 顺序,通常 GitLogViewer 选中的文件靠前),后续慢慢补全。
const HIGHLIGHT_CONCURRENCY = 4

watch(
  files,
  (fs) => {
    gen++
    const myGen = gen
    highlighted.value = new Map()
    if (!props.fetchContent) return
    const fetch = props.fetchContent
    const queue = fs.filter((f) => f.lang && !f.binary)
    let idx = 0

    const runOne = async (): Promise<void> => {
      while (myGen === gen) {
        const i = idx++
        if (i >= queue.length) return
        const f = queue[i]
        const [oldText, newText] = await Promise.all([
          f.oldName ? fetch('old', f.oldName).catch(() => null) : Promise.resolve(null),
          f.newName ? fetch('new', f.newName).catch(() => null) : Promise.resolve(null)
        ])
        if (myGen !== gen) return
        const [oldHtml, newHtml] = await Promise.all([
          oldText != null ? tokenizeFile(oldText, f.lang!) : Promise.resolve(null),
          newText != null ? tokenizeFile(newText, f.lang!) : Promise.resolve(null)
        ])
        if (myGen !== gen) return
        const next = new Map(highlighted.value)
        next.set(f.id, { old: oldHtml, new: newHtml })
        highlighted.value = next
      }
    }

    for (let i = 0; i < Math.min(HIGHLIGHT_CONCURRENCY, queue.length); i++) {
      void runOne()
    }
  },
  { immediate: true }
)

// 给单元格找它在整文件高亮中的对应行 HTML。
// num 是 1-based 行号。找不到（行号越界 / 没拉到内容）就 fallback 到 escape 后的原文，
// 保证显示不空。
function lineHtml(side: 'old' | 'new', f: FileView, num: number | null, text: string): string {
  if (num == null) return escapeHtml(text)
  const hl = highlighted.value.get(f.id)
  if (!hl) return escapeHtml(text)
  const arr = side === 'old' ? hl.old : hl.new
  if (!arr) return escapeHtml(text)
  return arr[num - 1] ?? escapeHtml(text)
}

const mainRef = ref<HTMLElement>()
const activeId = ref<string | null>(null)

function jumpTo(id: string): void {
  const host = mainRef.value
  if (!host) return
  const el = host.querySelector<HTMLElement>(`#${id}`)
  if (el) {
    host.scrollTo({ top: el.offsetTop - 4, behavior: 'smooth' })
    activeId.value = id
  }
}

// Side-by-side split ratio (left / right code columns). The two `*-num`
// columns stay at a fixed 3.2em each — only the two `*-code` columns share
// the remainder, so the ratio is just `left-code : right-code`. Shared
// across every file in this DiffViewer instance.
const midRatio = ref(0.5)

// Sidebar drag-to-resize
const MIN_SIDEBAR = 140
const MAX_SIDEBAR = 500
const sidebarWidth = ref(250)

function startColumnDrag(cursor: string, move: (event: MouseEvent) => void): void {
  stopActiveDrag?.()
  const previousCursor = document.body.style.cursor
  const previousUserSelect = document.body.style.userSelect

  const stop = (): void => {
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousUserSelect
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', stop)
    window.removeEventListener('blur', stop)
    if (stopActiveDrag === stop) stopActiveDrag = null
  }

  stopActiveDrag = stop
  document.body.style.cursor = cursor
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', stop)
  window.addEventListener('blur', stop)
}

function startSidebarDrag(e: MouseEvent): void {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = sidebarWidth.value

  function move(ev: MouseEvent): void {
    const dx = ev.clientX - startX
    sidebarWidth.value = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, startWidth + dx))
  }
  startColumnDrag('col-resize', move)
}

const gridStyle = (rowCount: number): Record<string, string> => ({
  gridTemplateColumns: `3.2em ${midRatio.value * 100}fr 3.2em ${(1 - midRatio.value) * 100}fr`,
  gridTemplateRows: `repeat(${Math.max(1, rowCount)}, auto)`
})

const sideStyle = (side: 'old' | 'new', rowCount: number): Record<string, string> => ({
  gridColumn: side === 'old' ? '1 / span 2' : '3 / span 2',
  gridRow: `1 / span ${Math.max(1, rowCount)}`
})

const splitterStyle = computed(() => ({
  left: `calc(3.2em + (100% - 6.4em) * ${midRatio.value})`
}))

function startMidDrag(e: MouseEvent): void {
  e.preventDefault()
  const wrap = (e.currentTarget as HTMLElement).parentElement
  if (!wrap) return
  const rect = wrap.getBoundingClientRect()
  const fontSize = parseFloat(getComputedStyle(wrap).fontSize) || 14
  const numColPx = 3.2 * fontSize
  const usable = Math.max(1, rect.width - numColPx * 2)

  function move(ev: MouseEvent): void {
    const xInUsable = ev.clientX - rect.left - numColPx
    midRatio.value = Math.max(0.1, Math.min(0.9, xInUsable / usable))
  }
  startColumnDrag('col-resize', move)
}
</script>

<template>
  <div class="dv-root">
    <aside v-if="!props.hideSidebar" class="dv-sidebar" :style="{ width: sidebarWidth + 'px' }">
      <div class="dv-sidebar-title">改动文件（{{ files.length }}）</div>
      <button
        v-for="f in files"
        :key="f.id"
        class="dv-file-item"
        :class="{ active: f.id === activeId }"
        @click="jumpTo(f.id)"
      >
        <span class="dv-badge" :class="f.statusClass">{{ f.status }}</span>
        <span class="dv-file-name" :title="f.name">{{ f.name }}</span>
        <span class="dv-counts">
          <span v-if="f.added" class="dv-add">+{{ f.added }}</span>
          <span v-if="f.deleted" class="dv-del">−{{ f.deleted }}</span>
        </span>
      </button>
    </aside>

    <div v-if="!props.hideSidebar" class="dv-sidebar-splitter" @mousedown="startSidebarDrag"></div>

    <div ref="mainRef" class="dv-main">
      <section v-for="f in files" :id="f.id" :key="f.id" class="dv-file">
        <header class="dv-file-head">
          <span class="dv-badge" :class="f.statusClass">{{ f.status }}</span>
          <span class="dv-file-name" :title="f.name">{{ f.name }}</span>
          <span class="dv-counts">
            <span v-if="f.added" class="dv-add">+{{ f.added }}</span>
            <span v-if="f.deleted" class="dv-del">−{{ f.deleted }}</span>
          </span>
        </header>
        <div v-if="f.binary" class="dv-binary">二进制文件，不显示差异</div>
        <div v-else-if="!f.rows.length" class="dv-binary">无文本差异</div>
        <div v-else class="dv-grid-wrap">
          <div class="dv-grid" :style="gridStyle(f.rows.length)">
            <div class="dv-side" :style="sideStyle('old', f.rows.length)">
              <template v-for="(r, ri) in f.rows" :key="`old-${ri}`">
                <div v-if="r.kind === 'hunk'" class="dv-hunk">{{ r.text }}</div>
                <template v-else>
                  <div class="dv-num" :class="r.left.kind">{{ r.left.num ?? '' }}</div>
                  <div
                    class="dv-code"
                    :class="r.left.kind"
                    v-html="lineHtml('old', f, r.left.num, r.left.text)"
                  ></div>
                </template>
              </template>
            </div>
            <div class="dv-side" :style="sideStyle('new', f.rows.length)">
              <template v-for="(r, ri) in f.rows" :key="`new-${ri}`">
                <div v-if="r.kind === 'hunk'" class="dv-hunk">{{ r.text }}</div>
                <template v-else>
                  <div class="dv-num" :class="r.right.kind">{{ r.right.num ?? '' }}</div>
                  <div
                    class="dv-code"
                    :class="r.right.kind"
                    v-html="lineHtml('new', f, r.right.num, r.right.text)"
                  ></div>
                </template>
              </template>
            </div>
          </div>
          <!-- Absolute splitter overlay positioned at the column-2/3 boundary.
               Pointer events are picked up only on the narrow drag handle to
               keep the grid fully clickable elsewhere (text selection still
               works). -->
          <div class="dv-mid-splitter" :style="splitterStyle" @mousedown="startMidDrag" />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
.dv-root {
  display: flex;
  height: 100%;
  min-height: 0;
  @include mono-font;
  user-select: text;
}

/* Left: changed-files list */
.dv-sidebar {
  flex-shrink: 0;
  overflow-y: auto;
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.dv-sidebar-splitter {
  width: 5px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  transition: background 0.12s;
  user-select: none;

  &:hover,
  &:active {
    background: var(--el-color-primary);
  }
}

.dv-sidebar-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--el-text-color-secondary);
  padding: 4px 8px 8px;
  @include ui-font;
}

.dv-file-item {
  @include btn-reset;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  border-radius: $radius;
  text-align: left;

  &:hover {
    background: var(--el-fill-color);
  }

  &.active {
    background: var(--el-color-primary-light-9);
  }
}

.dv-main {
  flex: 1;
  min-width: 0;
  overflow: auto;
}

.dv-file {
  margin-bottom: 18px;

  &:last-child {
    margin-bottom: 0;
  }
}

/* Filename stays pinned while scrolling through a long file. */
.dv-file-head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: var(--el-fill-color-light);
  border-bottom: 1px solid var(--el-border-color);
  @include ui-font;
}

.dv-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: $radius-sm;
  flex-shrink: 0;
  @include ui-font;

  &.st-new {
    color: color-mix(in srgb, var(--el-color-success) 75%, var(--el-text-color-primary));
    background: var(--el-color-success-light-8);
  }

  &.st-del {
    color: color-mix(in srgb, var(--el-color-danger) 75%, var(--el-text-color-primary));
    background: var(--el-color-danger-light-8);
  }

  &.st-ren {
    color: var(--el-color-warning);
    background: var(--el-color-warning-light-8);
  }

  /* "修改" is the most common diff status — keep it readable, not the muted
     info grey. Use the primary brand colour so it visually outweighs the
     placeholder/info-coloured tags. */
  &.st-mod {
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
  }
}

.dv-file-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--el-text-color-primary);
  @include ellipsis;
  @include mono-font;
}

.dv-counts {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  font-size: 11px;
}

.dv-add {
  color: color-mix(in srgb, var(--el-color-success) 75%, var(--el-text-color-primary));
}

.dv-del {
  color: color-mix(in srgb, var(--el-color-danger) 75%, var(--el-text-color-primary));
}

/* Wraps the grid + the absolute splitter overlay. position:relative so the
   splitter can absolute-position itself against this box. */
.dv-grid-wrap {
  position: relative;
}

/* Side-by-side grid: [old#][old code][new#][new code]. The two `code` columns
   share whatever remains after the two 3.2em number columns; the static
   declaration here is a fallback — the live ratio comes from the inline
   `gridTemplateColumns` style bound to midRatio. */
.dv-grid {
  display: grid;
  grid-template-columns: 3.2em minmax(0, 1fr) 3.2em minmax(0, 1fr);
  font-size: 12px;
  line-height: 1.5;
}

/* Keep each side contiguous in the DOM so native text selection cannot cross
   into the opposite side. Both nested grids reuse the outer row tracks, which
   preserves line-by-line alignment when either side wraps. */
.dv-side {
  display: grid;
  grid-template-columns: subgrid;
  grid-template-rows: subgrid;
  min-width: 0;
}

/* Vertical splitter pinned to the column-2/3 boundary. Wider hit area than
   visual to make grabbing it easy; the centred 2px-wide rule lights up on
   hover/drag so the affordance is visible without cluttering the diff. */
.dv-mid-splitter {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 9px;
  margin-left: -4px;
  cursor: col-resize;
  z-index: 2;
  user-select: none;

  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 3px;
    background: transparent;
    transition: background 0.12s;
  }

  &:hover::after,
  &:active::after {
    background: var(--el-color-primary);
  }
}

.dv-hunk {
  grid-column: 1 / -1;
  padding: 2px 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  white-space: pre-wrap;
  word-break: break-all;
}

.dv-num {
  text-align: right;
  padding: 0 0.6em;
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-lighter);
  border-right: 1px solid var(--el-border-color);
  user-select: none;
  white-space: nowrap;

  /* 仿 IDE gutter 风格:行号槽位用 20% 加深作为左侧"色块"强调。 */
  &.del {
    background: color-mix(in srgb, var(--el-color-danger) 20%, transparent);
    color: color-mix(in srgb, var(--el-color-danger) 70%, var(--el-text-color-regular));
  }

  &.ins {
    background: color-mix(in srgb, var(--el-color-success) 20%, transparent);
    color: color-mix(in srgb, var(--el-color-success) 70%, var(--el-text-color-regular));
  }

  &.empty {
    background: var(--el-fill-color-light);
  }
}

.dv-code {
  padding: 0 0.8em;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  color: var(--el-text-color-primary);

  /* 代码行用非常淡的色调(8%)只做提示;主对比留给行号槽位.色源用 element-plus
     主色变量 + color-mix 调透明度,主题切换自动跟随,无需维护 dark/light 双套. */
  &.del {
    background: color-mix(in srgb, var(--el-color-danger) 8%, transparent);
  }

  &.ins {
    background: color-mix(in srgb, var(--el-color-success) 8%, transparent);
  }

  &.empty {
    background: var(--el-fill-color-light);
  }
}

.dv-binary {
  padding: 16px 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  @include ui-font;
}
</style>

<style lang="scss">
/* shiki dual-theme：每个 token <span> inline style 里同时带
     color:<dark-rgb>          ← defaultColor:'dark' 让 dark 主题颜色直接落到 inline color
     --shiki-light:<light-rgb> ← light 主题颜色挂在 CSS 变量上

   dark 主题（app 默认 + main.ts 里强制设的 data-theme='dark'）什么都不用做，
   inline color 直接生效。light 主题时用 var(--shiki-light) 把 inline color 顶掉
   —— inline style 优先级高于 class，所以这里必须 !important。 */
[data-theme='light'] .dv-code span {
  color: var(--shiki-light) !important;
}
</style>
