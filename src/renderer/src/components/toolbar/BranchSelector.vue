<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  GitMerge,
  GitBranchPlus,
  ArrowUpFromLine,
  ArrowDownToLine,
  CornerDownRight,
  Trash2,
  GitBranch,
  ChevronsUpDown
} from 'lucide-vue-next'
import type { BranchInfo } from '@shared/types'

// 分支选择下拉 + 右键菜单 + "未提交变更"切换确认。
//
// 父 PaneToolbar 集中管理 git 状态快照(branches / currentBranch),本组件接收
// 后只做展示和操作;切换分支本身在本组件内 own 两个 local state:
//   - switching:控制 el-select 的 loading / disabled,防止重复触发
//   - optimisticBranch:乐观更新 —— gitCheckout 还没返回时 select 立刻显示
//     目标分支;成功后等父级 refresh 让 props.currentBranch 跟上再清掉,失败
//     则立即清掉回到原分支。
// 两个 state 全留在子组件,父级不必关心 → 避免双向同步的复杂度。

const props = defineProps<{
  cwd: string
  branches: BranchInfo[]
  currentBranch: string | null
}>()

const emit = defineEmits<{
  /** Git 状态发生变化 —— 父组件应 refresh。 */
  changed: []
  /** 用户在右键菜单点击"新工作树",父级负责打开 worktree 对话框并预填 prefill。 */
  worktreeFromBranch: [prefill: string]
  /** Git 操作进入冲突状态，父级立即打开合并面板。 */
  conflictDetected: []
  /** 下拉即将打开，父级完整刷新分支列表。 */
  refreshBranches: []
}>()

const showLocal = ref(true)
const showRemote = ref(true)

const localBranches = computed(() => props.branches.filter((b) => b.local))
const remoteBranches = computed(() => props.branches.filter((b) => b.remote))

function toggleLocal(checked: boolean | string | number): void {
  const v = Boolean(checked)
  if (!v && !showRemote.value) return // keep last one checked
  showLocal.value = v
}
function toggleRemote(checked: boolean | string | number): void {
  const v = Boolean(checked)
  if (!v && !showLocal.value) return
  showRemote.value = v
}

// --- 右键菜单 ------------------------------------------------------------
const branchMenuOpen = ref(false)
const branchMenuPos = ref({ x: 0, y: 0 })
const branchMenuTarget = ref<BranchInfo | null>(null)
const branchActionLoading = ref(false)
const showCreateBranch = ref(false)
const createBranchBase = ref<{ label: string; ref: string } | null>(null)
const newBranchName = ref('')
// 边缘 clamp 用:首次显示时 invisible 一帧测真实 size,clamp 完才显示。
const branchMenuRef = ref<HTMLDivElement>()
const branchMenuReady = ref(false)

const MENU_MARGIN = 4
function clampBranchMenu(): void {
  const el = branchMenuRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const maxX = window.innerWidth - rect.width - MENU_MARGIN
  const maxY = window.innerHeight - rect.height - MENU_MARGIN
  branchMenuPos.value = {
    x: Math.max(MENU_MARGIN, Math.min(branchMenuPos.value.x, maxX)),
    y: Math.max(MENU_MARGIN, Math.min(branchMenuPos.value.y, maxY))
  }
}

async function openBranchMenu(e: MouseEvent, b: BranchInfo): Promise<void> {
  e.preventDefault()
  e.stopPropagation()
  branchMenuTarget.value = b
  branchMenuPos.value = { x: e.clientX, y: e.clientY }
  branchMenuReady.value = false
  branchMenuOpen.value = true
  // 这里 **不** 关 el-select popper:之前关了会让 option 在右键时收回。menu
  // teleport 到 body 并加 z-index 3500,在 popper 上方。
  // 先 invisible 渲染拿真实 rect,clamp 到视口内后再 visible,避免边缘点击时
  // 菜单被裁掉一半项。
  await nextTick()
  clampBranchMenu()
  branchMenuReady.value = true
}

function closeBranchMenu(): void {
  branchMenuOpen.value = false
  branchMenuTarget.value = null
}

import { onMounted, onUnmounted } from 'vue'

function onGlobalMouseDown(e: MouseEvent): void {
  if (!branchMenuOpen.value) return
  const t = e.target as HTMLElement | null
  if (t?.closest('.branch-ctx-menu')) return
  closeBranchMenu()
}
onMounted(() => window.addEventListener('mousedown', onGlobalMouseDown, true))
onUnmounted(() => window.removeEventListener('mousedown', onGlobalMouseDown, true))

function ctxResolveRef(b: BranchInfo): string {
  return b.local ? b.name : `${b.remoteName || 'origin'}/${b.name}`
}

function ctxFromBranchValue(b: BranchInfo): string {
  return b.local ? `local:${b.name}` : `remote:${b.name}`
}

async function ctxMergeInto(): Promise<void> {
  const b = branchMenuTarget.value
  if (!b) return
  const ref = ctxResolveRef(b)
  closeBranchMenu()
  branchActionLoading.value = true
  try {
    const r = await window.api.gitMerge(props.cwd, ref)
    if (r.success) ElMessage.success(`已合并 ${ref} 到 ${props.currentBranch}`)
    else {
      const status = await window.api.gitMergeStatus(props.cwd)
      if (status.conflicts.length) emit('conflictDetected')
      else ElMessage.error(r.error || '合并失败')
    }
  } finally {
    branchActionLoading.value = false
    emit('changed')
  }
}

async function ctxRebaseOnto(): Promise<void> {
  const b = branchMenuTarget.value
  if (!b) return
  const ref = ctxResolveRef(b)
  closeBranchMenu()
  branchActionLoading.value = true
  try {
    const r = await window.api.gitRebase(props.cwd, ref)
    if (r.success) ElMessage.success(`已将 ${props.currentBranch} 变基到 ${ref}`)
    else {
      const status = await window.api.gitMergeStatus(props.cwd)
      if (status.conflicts.length) emit('conflictDetected')
      else ElMessage.error(r.error || '变基失败')
    }
  } finally {
    branchActionLoading.value = false
    emit('changed')
  }
}

function ctxWorktreeFrom(): void {
  const b = branchMenuTarget.value
  if (!b) return
  const prefill = ctxFromBranchValue(b)
  closeBranchMenu()
  emit('worktreeFromBranch', prefill)
}

function ctxCreateBranch(): void {
  const b = branchMenuTarget.value
  if (!b) return
  createBranchBase.value = { label: b.name, ref: ctxResolveRef(b) }
  newBranchName.value = ''
  closeBranchMenu()
  showCreateBranch.value = true
}

async function submitCreateBranch(): Promise<void> {
  const name = newBranchName.value.trim()
  const base = createBranchBase.value
  if (!name || !base || branchActionLoading.value) return
  branchActionLoading.value = true
  try {
    const r = await window.api.gitBranchCreate(props.cwd, name, base.ref)
    if (!r.success) {
      ElMessage.error(r.error || '新建分支失败')
      return
    }
    showCreateBranch.value = false
    optimisticBranch.value = name
    ElMessage.success(`已从 ${base.label} 新建并切换到 ${name}`)
    emit('changed')
  } finally {
    branchActionLoading.value = false
  }
}

async function ctxPush(): Promise<void> {
  const b = branchMenuTarget.value
  if (!b) return
  closeBranchMenu()
  branchActionLoading.value = true
  try {
    const r = await window.api.gitPush(props.cwd, b.name)
    if (r.success) ElMessage.success(`已推送 ${b.name}`)
    else ElMessage.error(r.error || '推送失败')
  } finally {
    branchActionLoading.value = false
    emit('changed')
  }
}

async function ctxPull(): Promise<void> {
  closeBranchMenu()
  branchActionLoading.value = true
  try {
    const r = await window.api.gitPull(props.cwd)
    if (r.success) ElMessage.success('已更新(fast-forward)')
    else ElMessage.error(r.error || '更新失败(可能需要先合并或变基)')
  } finally {
    branchActionLoading.value = false
    emit('changed')
  }
}

async function ctxDeleteBranch(): Promise<void> {
  const b = branchMenuTarget.value
  if (!b) return
  closeBranchMenu()
  try {
    await ElMessageBox.confirm(`确定删除本地分支 "${b.name}"?`, '删除分支', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  branchActionLoading.value = true
  try {
    let r = await window.api.gitBranchDelete(props.cwd, b.name, false)
    if (!r.success) {
      try {
        await ElMessageBox.confirm(
          `删除失败:${r.error || '该分支可能未合并'}\n是否强制删除?`,
          '强制删除分支',
          { confirmButtonText: '强制删除', cancelButtonText: '取消', type: 'warning' }
        )
      } catch {
        return
      }
      r = await window.api.gitBranchDelete(props.cwd, b.name, true)
    }
    if (r.success) {
      ElMessage.success(`已删除分支 "${b.name}"`)
      emit('changed')
    } else {
      ElMessage.error(r.error || '删除失败')
    }
  } finally {
    branchActionLoading.value = false
  }
}

const ctxIsCurrent = computed(() => branchMenuTarget.value?.name === props.currentBranch)
const ctxIsLocal = computed(() => !!branchMenuTarget.value?.local)

// --- 切换分支(含未提交变更 3-way 确认)---------------------------------
type SwitchTarget = { branch: string; isRemote: boolean; remoteName?: string }
const showSwitchConfirm = ref(false)
const pendingSwitch = ref<SwitchTarget | null>(null)

// 切换状态 + 乐观分支:都是 local。
const switching = ref(false)
const optimisticBranch = ref<string | null>(null)
// 显示用 = 乐观值优先,否则跟随父 currentBranch。
const displayBranch = computed(() => optimisticBranch.value ?? props.currentBranch)

// 父级 refresh 后 currentBranch 与乐观值一致 → 清掉 override 让回归 prop 驱动。
// (不一致也清:可能切换失败导致父级仍是旧分支,清掉总比留着 stale 强。)
watch(
  () => props.currentBranch,
  () => {
    optimisticBranch.value = null
  }
)

const onBranchChange = async (newBranch: string): Promise<void> => {
  if (switching.value) return
  if (newBranch === displayBranch.value) return

  const branch = props.branches.find((b) => b.name === newBranch)
  const target: SwitchTarget = {
    branch: newBranch,
    isRemote: !!branch && !branch.local && branch.remote,
    remoteName: branch?.remoteName
  }

  let hasChanges = false
  try {
    hasChanges = await window.api.gitHasChanges(props.cwd)
  } catch {
    hasChanges = false
  }
  if (hasChanges) {
    pendingSwitch.value = target
    showSwitchConfirm.value = true
    return
  }
  await doCheckout(target)
}

const doCheckout = async (t: SwitchTarget): Promise<void> => {
  switching.value = true
  optimisticBranch.value = t.branch
  try {
    const r = await window.api.gitCheckout(props.cwd, t.branch, t.isRemote, t.remoteName)
    if (r.success) {
      ElMessage.success(`已切换到分支 "${t.branch}"`)
      // 不清 optimisticBranch —— 等父级 refresh 拉到新 currentBranch,watch 自动清
    } else {
      ElMessage.error(r.error || '切换失败')
      optimisticBranch.value = null
    }
  } finally {
    switching.value = false
    emit('changed')
  }
}

const cancelSwitch = (): void => {
  showSwitchConfirm.value = false
  pendingSwitch.value = null
}

const switchDiscard = async (): Promise<void> => {
  const t = pendingSwitch.value
  showSwitchConfirm.value = false
  pendingSwitch.value = null
  if (t) await doCheckout(t)
}

const switchWithStash = async (): Promise<void> => {
  const t = pendingSwitch.value
  if (!t) return
  showSwitchConfirm.value = false
  pendingSwitch.value = null
  const r = await window.api.gitStash(props.cwd)
  if (!r.success) {
    ElMessage.error(r.error || '暂存失败')
    return
  }
  ElMessage.success('已暂存当前更改(git stash)')
  await doCheckout(t)
}
</script>

<template>
  <el-select
    :model-value="displayBranch"
    class="toolbar-select branch-select"
    popper-class="branch-select-dropdown"
    size="small"
    filterable
    :loading="switching"
    :disabled="switching"
    :suffix-icon="ChevronsUpDown"
    placeholder="(detached HEAD)"
    @change="onBranchChange"
    @visible-change="(visible: boolean) => visible && emit('refreshBranches')"
  >
    <template #prefix>
      <GitBranch :size="12" class="branch-prefix" />
    </template>
    <template #header>
      <div class="branch-filter-header">
        <el-checkbox :model-value="showLocal" size="small" @update:model-value="toggleLocal">
          本地 ({{ localBranches.length }})
        </el-checkbox>
        <el-checkbox :model-value="showRemote" size="small" @update:model-value="toggleRemote">
          远程 ({{ remoteBranches.length }})
        </el-checkbox>
      </div>
    </template>
    <el-option-group v-if="showLocal" label="本地分支">
      <el-option v-for="b in localBranches" :key="b.name" :label="b.name" :value="b.name">
        <span class="br-opt" @contextmenu="(e) => openBranchMenu(e, b)">
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
      <el-option v-for="b in remoteBranches" :key="b.name" :label="b.name" :value="b.name">
        <span class="br-opt" @contextmenu="(e) => openBranchMenu(e, b)">
          <span class="br-name">{{ b.name }}</span>
          <span class="br-tag remote">远程</span>
        </span>
      </el-option>
    </el-option-group>
  </el-select>

  <!-- Floating branch context menu. teleport-to-body so el-select popper's
       stacking context can't bury it. -->
  <Teleport to="body">
    <div
      v-if="branchMenuOpen && branchMenuTarget"
      ref="branchMenuRef"
      class="branch-ctx-menu"
      :style="{
        left: branchMenuPos.x + 'px',
        top: branchMenuPos.y + 'px',
        visibility: branchMenuReady ? 'visible' : 'hidden'
      }"
    >
      <button class="bm-item" :disabled="ctxIsCurrent || branchActionLoading" @click="ctxMergeInto">
        <GitMerge :size="13" />
        <span
          >将 <b>{{ branchMenuTarget.name }}</b> 合并到 <b>{{ currentBranch }}</b></span
        >
      </button>
      <button
        class="bm-item"
        :disabled="ctxIsCurrent || branchActionLoading"
        @click="ctxRebaseOnto"
      >
        <CornerDownRight :size="13" />
        <span
          >将 <b>{{ currentBranch }}</b> 变基到 <b>{{ branchMenuTarget.name }}</b></span
        >
      </button>
      <button class="bm-item" :disabled="branchActionLoading" @click="ctxWorktreeFrom">
        <GitBranchPlus :size="13" />
        <span
          >来自 <b>{{ branchMenuTarget.name }}</b> 的新工作树…</span
        >
      </button>
      <button class="bm-item" :disabled="branchActionLoading" @click="ctxCreateBranch">
        <GitBranchPlus :size="13" />
        <span
          >从 <b>{{ branchMenuTarget.name }}</b> 新建分支…</span
        >
      </button>
      <div v-if="ctxIsLocal" class="bm-sep" />
      <button v-if="ctxIsLocal" class="bm-item" :disabled="branchActionLoading" @click="ctxPush">
        <ArrowUpFromLine :size="13" />
        <span
          >推送 <b>{{ branchMenuTarget.name }}</b></span
        >
      </button>
      <button
        v-if="ctxIsLocal && ctxIsCurrent"
        class="bm-item"
        :disabled="branchActionLoading"
        @click="ctxPull"
      >
        <ArrowDownToLine :size="13" />
        <span>更新(fast-forward)</span>
      </button>
      <button
        v-if="ctxIsLocal && !ctxIsCurrent"
        class="bm-item danger"
        :disabled="branchActionLoading"
        @click="ctxDeleteBranch"
      >
        <Trash2 :size="13" />
        <span
          >删除 <b>{{ branchMenuTarget.name }}</b></span
        >
      </button>
    </div>
  </Teleport>

  <el-dialog
    v-model="showCreateBranch"
    :title="`从 ${createBranchBase?.label || ''} 新建分支`"
    width="420px"
    class="wt-dialog"
    :close-on-click-modal="false"
    @closed="createBranchBase = null"
  >
    <el-input
      v-model="newBranchName"
      placeholder="输入新分支名，例如 feature/login"
      autofocus
      @keyup.enter="submitCreateBranch"
    />
    <template #footer>
      <el-button size="small" @click="showCreateBranch = false">取消</el-button>
      <el-button
        size="small"
        type="primary"
        :disabled="!newBranchName.trim()"
        :loading="branchActionLoading"
        @click="submitCreateBranch"
      >
        新建并切换
      </el-button>
    </template>
  </el-dialog>

  <!-- Branch switch with uncommitted changes: 3-way choice -->
  <el-dialog
    v-model="showSwitchConfirm"
    title="当前有未提交的更改"
    width="420px"
    class="wt-dialog"
    @closed="cancelSwitch"
  >
    <div class="switch-msg">
      切换到分支 <b>{{ pendingSwitch?.branch }}</b> 前,工作区有未提交的更改。<br />
      可以先 <code>git stash</code> 暂存再切换,或直接切换(Git 会阻止会冲突的切换)。
    </div>
    <template #footer>
      <el-button size="small" @click="cancelSwitch">取消</el-button>
      <el-button size="small" @click="switchDiscard">直接切换</el-button>
      <el-button size="small" type="primary" @click="switchWithStash">暂存并切换</el-button>
    </template>
  </el-dialog>
</template>

<style
  scoped
  lang="scss"
  src="@renderer/assets/style/components/toolbar/BranchSelector.scss"
></style>
