<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  FolderGit2,
  Trash2,
  SplitSquareHorizontal,
  RefreshCw,
  GitBranch,
  LockKeyhole,
  Plus
} from 'lucide-vue-next'
import type { BranchInfo, WorktreeInfo } from '@shared/types'

// 工作树:新建对话框 + 管理对话框 + 两个工具栏按钮。
//
// 父组件 PaneToolbar 用 ref 调用 openWorktreeDialog(prefill) —— 来自 BranchSelector
// 的"来自分支的新工作树"右键菜单走这条路径。

type WorktreePlacement = 'top' | 'bottom' | 'left' | 'right'

const props = defineProps<{
  cwd: string
  branches: BranchInfo[]
  currentBranch: string | null
}>()

const emit = defineEmits<{
  worktreeCreated: [path: string, placement: WorktreePlacement]
  /** 增删 worktree 后通知父级 refresh —— "工作树" tag 在分支列表里可能要更新。 */
  changed: []
}>()

const showLocal = ref(true)
const showRemote = ref(true)

const localBranches = computed(() => props.branches.filter((b) => b.local))
const remoteBranches = computed(() => props.branches.filter((b) => b.remote))

function toggleLocal(checked: boolean | string | number): void {
  const v = Boolean(checked)
  if (!v && !showRemote.value) return
  showLocal.value = v
}
function toggleRemote(checked: boolean | string | number): void {
  const v = Boolean(checked)
  if (!v && !showLocal.value) return
  showRemote.value = v
}

// --- 新建对话框 ----------------------------------------------------------
const showWorktreeDialog = ref(false)
const wtFromBranch = ref('')
const wtNewBranch = ref(false)
const wtNewBranchName = ref('')
const wtProjectName = ref('')
const wtNameEdited = ref(false)
const wtLocation = ref('')
const wtPlacement = ref<WorktreePlacement>('right')
const wtSubmitting = ref(false)
const wtCopyTasks = ref(true)
const repoName = ref<string | null>(null)

const folderName = computed(() => {
  if (repoName.value) return repoName.value
  const parts = (props.cwd ?? '').replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || '项目'
})

const parentDir = computed(() => {
  const p = (props.cwd ?? '').replace(/\\/g, '/')
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.substring(0, idx) : p
})

function parseFromBranch(v: string): { source: 'local' | 'remote'; name: string } {
  const idx = v.indexOf(':')
  if (idx < 0) return { source: 'local', name: v }
  const src = v.slice(0, idx)
  return { source: src === 'remote' ? 'remote' : 'local', name: v.slice(idx + 1) }
}

const defaultProjectName = computed(() => {
  const fromName = parseFromBranch(wtFromBranch.value).name
  const raw =
    wtNewBranch.value && wtNewBranchName.value
      ? wtNewBranchName.value
      : fromName || props.currentBranch || 'worktree'
  const leaf = raw.split('/').filter(Boolean).pop() || 'worktree'
  return `${folderName.value}-${leaf}`
})

// 统一拼合 location + 项目名。之前 wtFullPath (显示用) 和 handleCreateWorktree
// (实际创建用) 各自写了一份判断,分歧:
//   - wtFullPath:cwd 含 '\\' OR loc 含 '\\' → '\\'
//   - handleCreate:只看 cwd 含 '\\'
// 导致用户浏览出 Windows 风格路径 (含 '\\')、而 cwd 是 OSC 7 给的 POSIX 风格
// (D:/foo) 时,UI 显示 `D:\foo\new` 但创建走 `D:/foo/new`,后续 pathExists 检查
// 用的不是同一条路径。这里抽 helper 两处共用。
function pickSep(cwd: string | undefined, location: string): string {
  return (cwd ?? '').includes('\\') || location.includes('\\') ? '\\' : '/'
}

function joinWorktreePath(location: string, name: string, cwd: string | undefined): string {
  const sep = pickSep(cwd, location)
  // 把 location 内的混合分隔符统一为 sep(避免 `D:/foo\bar\` 这样的输入),
  // 同时剥掉尾随分隔符。
  const norm = location.replace(/[\\/]+$/, '').replace(/[\\/]/g, sep)
  return `${norm}${sep}${name}`
}

const wtFullPath = computed(() => {
  const loc = wtLocation.value.trim()
  const name = wtProjectName.value.trim()
  if (!loc || !name) return ''
  return joinWorktreePath(loc, name, props.cwd)
})

const wtPathExists = ref(false)
let wtCheckGen = 0
watch([wtFullPath, showWorktreeDialog], async () => {
  if (!showWorktreeDialog.value || !wtFullPath.value) {
    wtPathExists.value = false
    return
  }
  const gen = ++wtCheckGen
  try {
    const exists = await window.api.pathExists(wtFullPath.value)
    if (gen === wtCheckGen) wtPathExists.value = exists
  } catch {
    if (gen === wtCheckGen) wtPathExists.value = false
  }
})

watch(wtFromBranch, (v) => {
  const { source, name } = parseFromBranch(v)
  if (source === 'remote' && !wtNewBranch.value) {
    wtNewBranch.value = true
    if (!wtNameEdited.value) wtNewBranchName.value = name
  }
})

watch([wtNewBranch, wtNewBranchName, wtFromBranch], () => {
  if (!wtNameEdited.value) wtProjectName.value = defaultProjectName.value
})

function onProjectNameInput(): void {
  wtNameEdited.value = true
}

async function openWorktreeDialog(prefillFrom?: string): Promise<void> {
  repoName.value = null
  wtFromBranch.value = prefillFrom || (props.currentBranch ? `local:${props.currentBranch}` : '')
  wtNewBranch.value = false
  wtNewBranchName.value = ''
  wtNameEdited.value = false
  wtLocation.value = parentDir.value
  wtPlacement.value = 'right'
  wtCopyTasks.value = true
  showWorktreeDialog.value = true

  if (props.cwd) {
    try {
      repoName.value = await window.api.getRepoName(props.cwd)
    } catch {
      repoName.value = null
    }
  }
  if (!wtNameEdited.value) wtProjectName.value = defaultProjectName.value
}

async function handleBrowseLocation(): Promise<void> {
  const dir = await window.api.selectDirectory()
  if (dir) wtLocation.value = dir
}

async function handleCreateWorktree(): Promise<void> {
  if (!wtProjectName.value.trim()) {
    ElMessage.error('请输入项目名')
    return
  }
  if (!wtLocation.value.trim()) {
    ElMessage.error('请选择位置')
    return
  }
  if (wtNewBranch.value) {
    const name = wtNewBranchName.value.trim()
    if (!name) {
      ElMessage.error('请输入新分支名')
      return
    }
    if (props.branches.some((b) => b.name === name && b.local)) {
      ElMessage.error(`本地分支 "${name}" 已存在`)
      return
    }
  }
  const fullPath = joinWorktreePath(wtLocation.value, wtProjectName.value.trim(), props.cwd)
  if (await window.api.pathExists(fullPath)) {
    wtPathExists.value = true
    ElMessage.error(`同名文件夹已存在:${fullPath}`)
    return
  }
  const { source, name: fromName } = parseFromBranch(wtFromBranch.value)
  let fromBranchRef: string | undefined
  if (source === 'remote' && fromName) {
    const info = props.branches.find((b) => b.name === fromName && b.remote)
    fromBranchRef = `${info?.remoteName || 'origin'}/${fromName}`
  } else {
    fromBranchRef = fromName || undefined
  }
  wtSubmitting.value = true
  try {
    const result = await window.api.gitWorktreeAdd(props.cwd, {
      path: fullPath,
      newBranch: wtNewBranch.value ? wtNewBranchName.value.trim() || undefined : undefined,
      fromBranch: fromBranchRef
    })
    if (result.success) {
      showWorktreeDialog.value = false
      if (result.warning) ElMessage.warning(result.warning)
      // 同步复制当前目录下的后台任务到新工作树
      if (wtCopyTasks.value && props.cwd) {
        cloneTasksToWorktree(props.cwd, fullPath)
      }
      emit('worktreeCreated', fullPath, wtPlacement.value)
    } else {
      ElMessage.error(result.error || '工作树创建失败')
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    wtSubmitting.value = false
  }
}

// 将当前 cwd 下的所有后台任务复制到新工作树路径(cwd 替换)。
// fire-and-forget:失败不阻塞工作树创建流程。
function normPath(p: string): string {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

async function cloneTasksToWorktree(fromCwd: string, toPath: string): Promise<void> {
  try {
    const all = await window.api.taskList()
    const target = normPath(fromCwd)
    const matching = all.filter((t) => {
      const tc = normPath(t.cwd)
      return tc === target || tc.startsWith(target + '/')
    })
    if (!matching.length) return
    // 并发创建,保留原名和命令,cwd 替换为新路径(子目录映射保留相对结构)
    await Promise.allSettled(
      matching.map((t) => {
        const newCwd = normPath(t.cwd).replace(target, normPath(toPath))
        return window.api.taskCreate({ name: t.name, command: t.command, cwd: newCwd })
      })
    )
  } catch {
    // 静默失败
  }
}

// --- 管理对话框 ----------------------------------------------------------
const showWtManage = ref(false)
const wtList = ref<WorktreeInfo[]>([])
const wtLoading = ref(false)
const wtRemoving = ref<string | null>(null)

async function loadWorktrees(): Promise<void> {
  if (!props.cwd) return
  wtLoading.value = true
  try {
    wtList.value = await window.api.gitWorktrees(props.cwd)
  } finally {
    wtLoading.value = false
  }
}

function openWtManage(): void {
  showWtManage.value = true
  loadWorktrees()
}

// 在右侧新 pane 打开该工作树。复用 worktreeCreated 事件(命名沿用语义偏"创建"
// 但本质上对接的就是"用 path 起新 pane"的管道,PaneToolbar → Terminal → App
// 那条链路无需改动)。打开后关闭管理对话框,避免点了之后 dialog 还挡着新 pane。
function openWorktree(w: WorktreeInfo): void {
  if (!w.path) return
  showWtManage.value = false
  emit('worktreeCreated', w.path, 'right')
}

async function removeWorktree(w: WorktreeInfo): Promise<void> {
  if (w.isMain) return
  try {
    await ElMessageBox.confirm(`删除工作树?\n${w.path}`, '删除工作树', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  wtRemoving.value = w.path
  try {
    let r = await window.api.gitWorktreeRemove(props.cwd, w.path, false)
    if (!r.success) {
      try {
        await ElMessageBox.confirm(
          `删除失败:${r.error || '该工作树可能有未提交更改或已锁定'}\n\n` +
            `是否强制删除工作树文件夹?\n` +
            `(直接删除磁盘上的文件夹 + git worktree prune,对 node_modules 等被文件锁占用的情况更鲁棒)`,
          '强制删除工作树',
          { confirmButtonText: '强制删除', cancelButtonText: '取消', type: 'warning' }
        )
      } catch {
        return
      }
      r = await window.api.gitWorktreeRemove(props.cwd, w.path, true)
    }
    if (r.success) {
      ElMessage.success('已删除工作树')
      await loadWorktrees()
      emit('changed')
    } else {
      ElMessage.error(r.error || '删除失败')
    }
  } finally {
    wtRemoving.value = null
  }
}

// 父级通过 ref 调用 —— BranchSelector 的 "来自分支的新工作树" 右键菜单走这里。
defineExpose({ openWorktreeDialog })
</script>

<template>
  <button class="wt-btn" title="新建工作树" aria-label="新建工作树" @click="openWorktreeDialog()">
    <Plus :size="13" />
  </button>
  <button class="wt-btn icon" title="管理工作树" aria-label="管理工作树" @click="openWtManage">
    <FolderGit2 :size="13" />
  </button>

  <el-dialog v-model="showWorktreeDialog" title="新建工作树" width="440px" class="wt-dialog">
    <div class="wt-form">
      <div class="wt-row">
        <label class="wt-label">从分支</label>
        <el-select
          v-model="wtFromBranch"
          class="wt-field"
          popper-class="branch-select-dropdown"
          size="small"
          filterable
        >
          <template #header>
            <div class="branch-filter-header">
              <el-checkbox :model-value="showLocal" size="small" @update:model-value="toggleLocal">
                本地 ({{ localBranches.length }})
              </el-checkbox>
              <el-checkbox
                :model-value="showRemote"
                size="small"
                @update:model-value="toggleRemote"
              >
                远程 ({{ remoteBranches.length }})
              </el-checkbox>
            </div>
          </template>
          <el-option-group v-if="showLocal" label="本地分支">
            <el-option
              v-for="b in localBranches"
              :key="`local:${b.name}`"
              :label="b.name"
              :value="`local:${b.name}`"
            >
              <span class="br-opt">
                <span class="br-name">{{ b.name }}</span>
                <span v-if="b.worktree" class="br-tag worktree" title="该分支已在其他工作树检出"
                  >工作树</span
                >
                <span class="br-tag local">本地</span>
                <span v-if="b.remote" class="br-tag remote">远程</span>
              </span>
            </el-option>
          </el-option-group>
          <el-option-group v-if="showRemote && remoteBranches.length" label="远程分支">
            <el-option
              v-for="b in remoteBranches"
              :key="`remote:${b.name}`"
              :label="`${b.remoteName || 'origin'}/${b.name}`"
              :value="`remote:${b.name}`"
            >
              <span class="br-opt">
                <span class="br-name">{{ b.remoteName || 'origin' }}/{{ b.name }}</span>
                <span class="br-tag remote">远程</span>
              </span>
            </el-option>
          </el-option-group>
        </el-select>
      </div>

      <div class="wt-row">
        <label class="wt-label">新分支</label>
        <div class="wt-field" style="display: flex; align-items: center; gap: 8px">
          <el-checkbox v-model="wtNewBranch" />
          <el-input
            v-if="wtNewBranch"
            v-model="wtNewBranchName"
            size="small"
            placeholder="新分支名"
            style="flex: 1"
          />
        </div>
      </div>

      <div class="wt-row">
        <label class="wt-label">项目名</label>
        <el-input
          v-model="wtProjectName"
          class="wt-field"
          size="small"
          @input="onProjectNameInput"
        />
      </div>

      <div class="wt-row">
        <label class="wt-label">位置</label>
        <div class="wt-field" style="display: flex; gap: 8px">
          <el-input v-model="wtLocation" size="small" style="flex: 1" />
          <el-button size="small" @click="handleBrowseLocation">浏览</el-button>
        </div>
      </div>

      <div class="wt-row">
        <label class="wt-label">面板位置</label>
        <el-radio-group v-model="wtPlacement" size="small" class="wt-field wt-placement">
          <el-radio-button label="top">上</el-radio-button>
          <el-radio-button label="bottom">下</el-radio-button>
          <el-radio-button label="left">左</el-radio-button>
          <el-radio-button label="right">右</el-radio-button>
        </el-radio-group>
      </div>

      <div class="wt-row">
        <label class="wt-label" />
        <el-checkbox v-model="wtCopyTasks" size="small" class="wt-field">
          复制当前文件夹的后台任务
        </el-checkbox>
      </div>
    </div>

    <div v-if="wtPathExists" class="wt-warn">同名文件夹已存在:{{ wtFullPath }}</div>

    <template #footer>
      <el-button size="small" @click="showWorktreeDialog = false">取消</el-button>
      <el-button size="small" type="primary" :loading="wtSubmitting" @click="handleCreateWorktree">
        创建工作树
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="showWtManage"
    title="管理工作树"
    width="720px"
    class="wt-dialog wt-manage-dialog"
  >
    <div class="wt-manage-head">
      <div>
        <div class="wt-manage-summary">{{ wtList.length }} 个工作树</div>
        <div class="wt-manage-desc">在新面板中打开，或移除不再使用的工作树</div>
      </div>
      <button class="wt-refresh-btn" :disabled="wtLoading" @click="loadWorktrees">
        <RefreshCw :size="13" :class="{ spinning: wtLoading }" />
        刷新
      </button>
    </div>
    <div v-if="wtLoading" class="wt-manage-empty">加载中…</div>
    <div v-else-if="!wtList.length" class="wt-manage-empty">没有工作树</div>
    <div v-else class="wt-manage-list">
      <div v-for="w in wtList" :key="w.path" class="wt-manage-row">
        <div class="wt-manage-info">
          <div class="wt-manage-meta">
            <GitBranch :size="12" />
            <span class="wt-manage-branch">
              {{ w.detached ? '分离 HEAD' : w.branch || '未知分支' }}
            </span>
            <span v-if="w.isMain" class="br-tag local">主工作树</span>
            <span v-if="w.locked" class="br-tag worktree">
              <LockKeyhole :size="10" />
              已锁定
            </span>
          </div>
          <div class="wt-manage-path" :title="w.path">{{ w.path }}</div>
        </div>
        <button class="wt-open-btn" title="在右侧新面板打开" @click="openWorktree(w)">
          <SplitSquareHorizontal :size="14" />
          <span>打开</span>
        </button>
        <button
          v-if="!w.isMain"
          class="wt-del-btn"
          :disabled="wtRemoving === w.path"
          title="删除此工作树"
          @click="removeWorktree(w)"
        >
          <Trash2 :size="14" />
        </button>
      </div>
    </div>
    <template #footer>
      <el-button size="small" @click="showWtManage = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
// wt-open-btn 和 wt-del-btn 完全同形:28x28 + 1px 半透明 border + 同色 hover。
// 差异只在 border 色 / text 色,用 mixin 把这段壳子拎出来。
@mixin wt-action-btn($color) {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, #{$color} 40%, transparent);
  color: $color;
  border-radius: 6px;
}

.wt-btn {
  @include toolbar-icon-button;
  font-size: 14px;
  line-height: 1;

  &.icon {
    font-size: 0;
  }
}

.wt-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.wt-row {
  display: flex;
  align-items: stretch;
  flex-direction: column;
  gap: 7px;
}

.wt-label {
  width: auto;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  font-weight: 600;
  text-align: left;
}

.wt-field {
  flex: 1;
  min-width: 0;
}

.wt-placement {
  display: flex;

  :deep(.el-radio-button) {
    flex: 1;
  }

  :deep(.el-radio-button__inner) {
    width: 100%;
    min-height: 32px;
    padding: 8px 10px;
  }
}

.wt-warn {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--el-color-warning) 27%, transparent);
  padding: 10px 12px;
  border-radius: 6px;
  word-break: break-all;
}

.wt-manage-empty {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  padding: 24px 4px;
  text-align: center;
}

.wt-manage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  padding: 0 2px 14px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.wt-manage-summary {
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 600;
}

.wt-manage-desc {
  margin-top: 2px;
  color: var(--el-text-color-placeholder);
  font-size: 11px;
}

.wt-refresh-btn {
  @include btn-reset;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  color: var(--el-text-color-secondary);
  font-size: 11px;

  &:hover:not(:disabled) {
    background: var(--el-fill-color);
    color: var(--el-text-color-primary);
  }

  &:disabled {
    opacity: 0.55;
  }
}

.spinning {
  animation: wt-spin 0.8s linear infinite;
}

@keyframes wt-spin {
  to {
    transform: rotate(360deg);
  }
}

.wt-manage-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 52vh;
  overflow-y: auto;
}

.wt-manage-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;

  &:hover {
    background: var(--el-fill-color-lighter);
    border-color: var(--el-border-color);
  }
}

.wt-manage-info {
  flex: 1;
  min-width: 0;
}

.wt-manage-path {
  margin-top: 5px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  @include mono-font;
  @include ellipsis;
}

.wt-manage-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--el-text-color-secondary);
}

.wt-manage-branch {
  color: var(--el-text-color-primary);
  font-size: 12.5px;
  font-weight: 600;
}

.wt-open-btn {
  @include wt-action-btn(var(--el-color-primary));
  width: auto;
  padding: 0 9px;
  gap: 5px;
  font-size: 11px;

  &:hover {
    background: color-mix(in srgb, var(--el-color-primary) 13%, transparent);
    border-color: var(--el-color-primary);
  }
}

.wt-del-btn {
  @include wt-action-btn(var(--el-color-danger));

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--el-color-danger) 13%, transparent);
    border-color: var(--el-color-danger);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>
