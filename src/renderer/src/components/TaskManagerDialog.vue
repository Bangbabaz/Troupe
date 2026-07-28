<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, X, FolderOpen } from 'lucide-vue-next'
import { useTasks } from '../composables/useTasks'

interface EditItem {
  key: string
  id?: string // undefined = unsaved draft
  name: string
  command: string
  cwd: string
  isNew: boolean
  dirty: boolean
}

// 管理命令对话框 —— **只对当前面板/文件夹负责**。scopeCwd 决定列表只显示这个
// 文件夹的命令,以及新建草稿默认 cwd 也是这里。跨文件夹的"统一管理"在
// TasksDrawer 里(那里按 cwd 分组列出全部任务)。
//
// 列表里仍然可能出现 cwd 不在 scope 的行:当前选中的(actively edited)行,
// 即使把 cwd 改成了别的目录也不让它消失,否则用户改一半就丢了 selection。

const props = defineProps<{
  modelValue: boolean
  focusId: string | null
  defaultCwd: string
  /** null = 兼容模式:列全部。正常入口都会带 scopeCwd。 */
  scopeCwd: string | null
  /** 打开时立即起一个 draft,放在 scopeCwd / defaultCwd 文件夹下。 */
  newDraft: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()

const items = ref<EditItem[]>([])
const selectedKey = ref<string | null>(null)

const MIN_LIST_WIDTH = 120
const MAX_LIST_WIDTH = 500
const listWidth = ref(210)

function startResize(e: MouseEvent): void {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = listWidth.value

  function move(ev: MouseEvent): void {
    const dx = ev.clientX - startX
    listWidth.value = Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, startWidth + dx))
  }
  function up(): void {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

let keySeq = 0
const nextKey = (): string => `k${++keySeq}`

const selected = computed(() => items.value.find((i) => i.key === selectedKey.value) || null)

const itemLabel = (i: EditItem): string => i.name.trim() || i.command.trim() || 'new command'

const norm = (p: string | null | undefined): string => {
  let s = (p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase()
  return s
}

// scope 模式:只显示该 cwd 的命令,外加 selected 行(让 cwd 编辑过程中不丢)。
// 无 scope:全部展示(legacy)。
const visibleItems = computed(() => {
  if (!props.scopeCwd) return items.value
  const sc = norm(props.scopeCwd)
  return items.value.filter((i) => norm(i.cwd) === sc || i.key === selectedKey.value)
})

const scopeName = computed(() => {
  if (!props.scopeCwd) return ''
  const parts = props.scopeCwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || props.scopeCwd
})
const dialogTitle = computed(() => (props.scopeCwd ? `管理命令 · ${scopeName.value}` : '管理命令'))

// 全局共享任务列表。不再用 taskList() 快照 —— 直接读 allTasks,自动反映
// 其他 pane 的创建/修改/删除。
const { allTasks, ready: tasksReady } = useTasks()

function buildItems(): void {
  items.value = allTasks.value.map((t) => ({
    key: nextKey(),
    id: t.id,
    name: t.name,
    command: t.command,
    cwd: t.cwd,
    isNew: false,
    dirty: false
  }))
  const focus = props.focusId ? items.value.find((i) => i.id === props.focusId) : undefined
  const sc = props.scopeCwd ? norm(props.scopeCwd) : null
  const firstInScope = sc ? items.value.find((i) => norm(i.cwd) === sc) : items.value[0]
  selectedKey.value = focus?.key ?? firstInScope?.key ?? null
}

// 对话框打开期间,外部(其他 pane / TasksDrawer)可能创建、更新或删除任务。
// 这里把 allTasks 的实时变更同步到本地 items,但不覆盖用户正在编辑的脏行。
watch(allTasks, (tasks) => {
  // 新增 + 更新:only sync non-dirty items
  for (const t of tasks) {
    const existing = items.value.find((i) => i.id === t.id)
    if (existing && !existing.dirty) {
      existing.name = t.name
      existing.command = t.command
      existing.cwd = t.cwd
    } else if (!existing) {
      items.value.push({
        key: nextKey(),
        id: t.id,
        name: t.name,
        command: t.command,
        cwd: t.cwd,
        isNew: false,
        dirty: false
      })
    }
  }
  // 删除:移除已不存在的行,保护未保存草稿(isNew)
  for (let i = items.value.length - 1; i >= 0; i--) {
    const item = items.value[i]
    if (item.isNew) continue
    if (item.id && !tasks.some((t) => t.id === item.id)) {
      const wasSelected = selectedKey.value === item.key
      items.value.splice(i, 1)
      if (wasSelected) {
        const sc = props.scopeCwd ? norm(props.scopeCwd) : null
        const candidates = sc ? items.value.filter((x) => norm(x.cwd) === sc) : items.value
        selectedKey.value = candidates[0]?.key ?? null
      }
    }
  }
})

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    await tasksReady
    buildItems()
    if (props.newDraft) addDraft(props.scopeCwd || undefined)
  }
)

function select(i: EditItem): void {
  selectedKey.value = i.key
}

function addDraft(cwd?: string): void {
  const draft: EditItem = {
    key: nextKey(),
    name: '',
    command: '',
    cwd: cwd || props.scopeCwd || props.defaultCwd || '',
    isNew: true,
    dirty: true
  }
  items.value.push(draft)
  selectedKey.value = draft.key
}

function markDirty(): void {
  if (selected.value) selected.value.dirty = true
}

async function browseCwd(): Promise<void> {
  const dir = await window.api.selectDirectory()
  if (dir && selected.value) {
    selected.value.cwd = dir
    selected.value.dirty = true
  }
}

async function deleteItem(i: EditItem): Promise<void> {
  if (!i.isNew && i.id) {
    try {
      await ElMessageBox.confirm(`删除命令 "${itemLabel(i)}"?运行中的进程会被结束。`, '删除命令', {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      })
    } catch {
      return
    }
    await window.api.taskRemove(i.id)
  }
  const idx = items.value.findIndex((x) => x.key === i.key)
  if (idx >= 0) items.value.splice(idx, 1)
  if (selectedKey.value === i.key) {
    // 选择栏在 scope 内推一项;legacy 模式回退到 items[0]
    const sc = props.scopeCwd ? norm(props.scopeCwd) : null
    const candidates = sc ? items.value.filter((x) => norm(x.cwd) === sc) : items.value
    selectedKey.value = candidates[0]?.key ?? null
  }
}

async function save(): Promise<void> {
  const s = selected.value
  if (!s) return
  const command = s.command.trim()
  if (!command) {
    ElMessage.error('请输入命令')
    return
  }
  const cwd = s.cwd.trim()
  if (!cwd) {
    ElMessage.error('请输入工作目录')
    return
  }
  const name = s.name.trim() || command
  if (s.isNew || !s.id) {
    const meta = await window.api.taskCreate({ name, command, cwd })
    s.id = meta.id
    s.isNew = false
  } else {
    await window.api.taskUpdate(s.id, { name, command, cwd })
  }
  s.name = name
  s.dirty = false
  ElMessage.success('已保存')
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="840px"
    :with-header="true"
    class="task-mgr-dialog"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="tm-body">
      <aside class="tm-list" :style="{ width: listWidth + 'px' }">
        <div class="tm-list-head">
          <div>
            <span class="tm-list-title">命令</span>
            <span class="tm-list-count">{{ visibleItems.length }}</span>
          </div>
          <button class="tm-add" title="新建命令" @click="addDraft()">
            <Plus :size="14" />
          </button>
        </div>
        <div class="tm-list-scroll">
          <div v-if="!visibleItems.length" class="tm-empty">该文件夹还没有命令</div>
          <div
            v-for="i in visibleItems"
            :key="i.key"
            class="tm-item"
            :class="{ active: i.key === selectedKey }"
            @click="select(i)"
          >
            <span class="tm-item-content">
              <span class="tm-item-label">{{ itemLabel(i) }}</span>
              <span class="tm-item-command">{{ i.command || '尚未填写命令' }}</span>
            </span>
            <span v-if="i.isNew" class="tm-badge new">未保存</span>
            <span v-else-if="i.dirty" class="tm-dot" title="有未保存的修改" />
            <button class="tm-del" title="删除" @click.stop="deleteItem(i)">
              <X :size="13" />
            </button>
          </div>
        </div>
      </aside>

      <div class="tm-resizer" @mousedown="startResize"></div>

      <section class="tm-detail">
        <template v-if="selected">
          <div class="tm-detail-head">
            <div>
              <div class="tm-detail-title">{{ itemLabel(selected) }}</div>
              <div class="tm-detail-subtitle">配置命令、工作目录和显示名称</div>
            </div>
            <span v-if="selected.isNew || selected.dirty" class="tm-unsaved">未保存</span>
          </div>
          <label class="tm-field">
            <span class="tm-label">名称</span>
            <input
              v-model="selected.name"
              class="tm-input"
              placeholder="留空则用命令文本"
              @input="markDirty"
            />
          </label>
          <label class="tm-field">
            <span class="tm-label">命令</span>
            <input
              v-model="selected.command"
              class="tm-input mono"
              placeholder="如 npm run dev"
              @input="markDirty"
            />
          </label>
          <label class="tm-field">
            <span class="tm-label">工作目录</span>
            <div class="tm-cwd-row">
              <input
                v-model="selected.cwd"
                class="tm-input mono"
                placeholder="命令执行的目录"
                @input="markDirty"
              />
              <button class="tm-browse" title="浏览" @click="browseCwd">
                <FolderOpen :size="14" />
              </button>
            </div>
          </label>
          <div class="tm-actions">
            <span class="tm-hint">未保存的更改关闭后会丢弃</span>
            <button class="tm-save" :disabled="!selected.command.trim()" @click="save">保存</button>
          </div>
        </template>
        <div v-else class="tm-placeholder">选择左侧命令,或点 + 新建</div>
      </section>
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
// 输入框、cwd 选择器和 saved 按钮都共享同一套外观元素 —— 透明背景、border、
// radius 和 focus 描边 —— 抽公共 placeholder。
%outlined-control {
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: $radius;
  color: var(--el-text-color-regular);
}

.tm-body {
  display: flex;
  height: 520px;
  gap: 0;
  margin: 0;
}

.tm-list {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 10px;
  background: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color-light);
}

.tm-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 10px;
}

.tm-list-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
}

.tm-list-count {
  margin-left: 6px;
  color: var(--el-text-color-placeholder);
  font-size: 10px;
}

.tm-add {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--el-border-color);
  border-radius: $radius;
  color: var(--el-text-color-regular);

  &:hover {
    background: var(--el-fill-color);
    color: var(--el-text-color-primary);
  }
}

.tm-list-scroll {
  flex: 1;
  overflow-y: auto;
  padding-right: 2px;
}

.tm-empty {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  padding: 16px 4px;
}

.tm-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 7px;
  border-radius: $radius-md;
  cursor: pointer;

  &:hover {
    background: var(--el-fill-color);

    .tm-del {
      display: flex;
    }
  }

  &.active {
    background: color-mix(in srgb, var(--el-color-primary) 11%, transparent);
    box-shadow: inset 2px 0 0 var(--el-color-primary);
  }
}

.tm-item-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.tm-item-label {
  font-size: 12.5px;
  color: var(--el-text-color-primary);
  @include ellipsis;
}

.tm-item-command {
  color: var(--el-text-color-placeholder);
  font-size: 10.5px;
  @include mono-font;
  @include ellipsis;
}

.tm-badge.new {
  font-size: 10px;
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 13%, transparent);
  padding: 1px 5px;
  border-radius: $radius-sm;
  flex-shrink: 0;
}

.tm-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-warning);
  flex-shrink: 0;
}

.tm-del {
  @include btn-reset;
  display: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--el-text-color-secondary);
  border-radius: $radius-sm;
  flex-shrink: 0;

  &:hover {
    background: color-mix(in srgb, var(--el-color-danger) 27%, transparent);
    color: var(--el-color-danger);
  }
}

.tm-resizer {
  width: 4px;
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

.tm-detail {
  flex: 1;
  min-width: 0;
  padding: 24px 28px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.tm-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.tm-detail-title {
  color: var(--el-text-color-primary);
  font-size: 16px;
  font-weight: 600;
}

.tm-detail-subtitle {
  margin-top: 2px;
  color: var(--el-text-color-placeholder);
  font-size: 11px;
}

.tm-unsaved {
  padding: 2px 7px;
  border-radius: var(--el-border-radius-round);
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
  font-size: 10px;
}

.tm-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.tm-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.tm-input {
  @extend %outlined-control;
  color: var(--el-text-color-primary);
  font-size: 13px;
  padding: 7px 9px;
  outline: none;
  font-family: inherit;
  @include focus-accent;

  &.mono {
    @include mono-font;
    font-size: 12px;
  }
}

.tm-cwd-row {
  display: flex;
  gap: 6px;

  .tm-input {
    flex: 1;
    min-width: 0;
  }
}

.tm-browse {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  border: 1px solid var(--el-border-color);
  border-radius: $radius;
  color: var(--el-text-color-regular);

  &:hover {
    background: var(--el-fill-color);
    color: var(--el-text-color-primary);
  }
}

.tm-actions {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.tm-hint {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.tm-save {
  @include btn-reset;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 13px;
  padding: 7px 20px;
  border-radius: $radius;

  &:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  &:disabled {
    background: var(--el-disabled-bg-color);
    color: var(--el-text-color-disabled);
    cursor: not-allowed;
  }
}

.tm-placeholder {
  margin: auto;
  color: var(--el-text-color-placeholder);
  font-size: 13px;
}
</style>
