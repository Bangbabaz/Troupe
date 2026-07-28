<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Bot, Folder, Globe, GripVertical, Server } from 'lucide-vue-next'
import BranchSelector from './toolbar/BranchSelector.vue'
import WorktreePanel from './toolbar/WorktreePanel.vue'
import GitOpsButtons from './toolbar/GitOpsButtons.vue'
import DiffStatsButton from './toolbar/DiffStatsButton.vue'
import TaskRunner from './toolbar/TaskRunner.vue'
import IdeLauncher from './toolbar/IdeLauncher.vue'
import type { BranchInfo, DiffStats, MergeStatus } from '@shared/types'

// 工具栏协调器。集中管理 git 状态(branches / currentBranch / diffStats /
// mergeStatus),通过 props 下发到子组件;子组件触发 git 操作后 emit('changed'),
// 由本组件统一刷新。
//
// 改造关键点:
//   1. 非 git 目录也渲染工具栏 —— 仅隐藏 BranchSelector / WorktreePanel /
//      GitOpsButtons,TaskRunner + IdeLauncher 与 git 无关,任意 cwd 都可用。
//   2. refresh() 节流:Terminal focus 频繁触发,200ms 内合并多次。
//   3. 快速刷新只查分支头 / diff / 冲突；完整刷新才重扫分支列表。

type WorktreePlacement = 'top' | 'bottom' | 'left' | 'right'

const props = defineProps<{
  paneId: string
  cwd: string | undefined
  isRemote?: boolean
  remoteLabel?: string
}>()

const emit = defineEmits<{
  worktreeCreated: [path: string, placement: WorktreePlacement]
  manageTasks: [cwd?: string, newDraft?: boolean]
  toggleAgentSessions: []
  toggleBrowser: []
  paneDragStart: []
}>()

// --- Git 状态(从 IPC 拉取的快照,下发给 BranchSelector / WorktreePanel /
//     GitOpsButtons)----------------------------------------------------------
const isRepo = ref(false)
const currentBranch = ref<string | null>(null)
const branches = ref<BranchInfo[]>([])
const diffStats = ref<DiffStats>({ added: 0, deleted: 0 })
const mergeStatus = ref<MergeStatus | null>(null)

const locationName = computed(() => {
  const normalized = (props.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || 'Terminal'
})
// switching / 乐观分支显示都留在 BranchSelector 内部 —— 父级不需要参与切换流程,
// 切完只关心 refresh,通过子级 emit('changed') 触发。

// 各字段独立 generation：快速刷新不会取消仍在进行的分支列表刷新，而同一字段
// 的旧请求又不会覆盖新结果。
let infoGen = 0
let branchesGen = 0
let statsGen = 0
let mergeGen = 0

// 200ms throttle:窗口 / focus / cwd 变化连续触发时合并。第一次立即跑,后续 200ms
// 内合并到一次,最末状态最准。
let throttleTimer: ReturnType<typeof setTimeout> | null = null
let throttlePending = false
let pendingMode: 'fast' | 'full' = 'fast'
let lastRunAt = 0
const THROTTLE_MS = 200

const refresh = async (mode: 'fast' | 'full' = 'full'): Promise<void> => {
  if (!props.cwd) return
  if (props.isRemote) {
    isRepo.value = false
    currentBranch.value = null
    branches.value = []
    mergeStatus.value = null
    diffStats.value = { added: 0, deleted: 0 }
    return
  }
  const cwd = props.cwd
  const myInfoGen = ++infoGen
  try {
    const info = await window.api.getGitInfo(cwd)
    if (myInfoGen !== infoGen || cwd !== props.cwd) return
    if (!info.isRepo) {
      isRepo.value = false
      currentBranch.value = null
      branches.value = []
      mergeStatus.value = null
      diffStats.value = { added: 0, deleted: 0 }
      return
    }
    // 当前分支先落 UI，不再等待 diff / merge / branches 全部完成。
    isRepo.value = true
    currentBranch.value = info.branch

    const myStatsGen = ++statsGen
    const myMergeGen = ++mergeGen
    const jobs: Promise<void>[] = [
      window.api.getGitDiffStats(cwd).then((stats) => {
        if (myStatsGen === statsGen && cwd === props.cwd) diffStats.value = stats
      }),
      window.api.gitMergeStatus(cwd).then((merge) => {
        if (myMergeGen === mergeGen && cwd === props.cwd) mergeStatus.value = merge
      })
    ]

    if (mode === 'full') {
      const myBranchesGen = ++branchesGen
      jobs.push(
        window.api.getGitBranches(cwd).then((list) => {
          if (myBranchesGen === branchesGen && cwd === props.cwd) branches.value = list
        })
      )
    }
    await Promise.allSettled(jobs)
  } catch {
    if (myInfoGen !== infoGen || cwd !== props.cwd) return
    isRepo.value = false
    currentBranch.value = null
    branches.value = []
    mergeStatus.value = null
  }
}

const requestRefresh = (mode: 'fast' | 'full' = 'full'): void => {
  const now = Date.now()
  const elapsed = now - lastRunAt
  if (elapsed >= THROTTLE_MS) {
    lastRunAt = now
    void refresh(mode)
    return
  }
  // 已经在节流窗口内:挂起一次尾随调用,确保最末状态最终落地。
  if (throttlePending) {
    if (mode === 'full') pendingMode = 'full'
    return
  }
  throttlePending = true
  pendingMode = mode
  if (throttleTimer) clearTimeout(throttleTimer)
  throttleTimer = setTimeout(() => {
    throttlePending = false
    throttleTimer = null
    lastRunAt = Date.now()
    const modeToRun = pendingMode
    pendingMode = 'fast'
    void refresh(modeToRun)
  }, THROTTLE_MS - elapsed)
}

const requestFastRefresh = (): void => requestRefresh('fast')

// cwd 改变(用户 cd 或者新建 worktree pane)→ 立即触发一次新状态拉取。
// 通过 requestRefresh 走节流,但 cwd 变化频率不高,实际上等价于立即 refresh。
watch(
  () => [props.cwd, props.isRemote],
  () => requestRefresh(),
  { immediate: true }
)

defineExpose({ refresh: requestRefresh, refreshFast: requestFastRefresh })

// --- Worktree dialog 入口 -----------------------------------------------
// BranchSelector 右键"新工作树"→ 父级转发到 WorktreePanel.openWorktreeDialog。
const worktreePanelRef = ref<InstanceType<typeof WorktreePanel>>()
const gitOpsRef = ref<InstanceType<typeof GitOpsButtons>>()

function onWorktreeFromBranch(prefill: string): void {
  worktreePanelRef.value?.openWorktreeDialog(prefill)
}

function onWorktreeCreated(path: string, placement: WorktreePlacement): void {
  emit('worktreeCreated', path, placement)
}

async function onConflictDetected(): Promise<void> {
  await refresh('fast')
  gitOpsRef.value?.openMergePanel()
}
</script>

<template>
  <!-- 工具栏 v-if 仅在 cwd 已知时渲染;不再以 isRepo 为条件,非 git 目录也展示
       TaskRunner + IdeLauncher。 -->
  <div v-if="props.cwd" class="pane-toolbar" @click.stop>
    <div class="pane-identity">
      <button
        class="pane-drag-handle"
        title="拖拽以重排面板"
        @mousedown.left.prevent.stop="emit('paneDragStart')"
      >
        <GripVertical :size="13" />
      </button>
      <div class="pane-location" :title="props.cwd">
        <Folder :size="13" class="pane-location-icon" />
        <span class="pane-location-name">{{ locationName }}</span>
      </div>
    </div>

    <div v-if="isRepo" class="pane-toolbar-section pane-git-section">
      <BranchSelector
        :cwd="props.cwd"
        :branches="branches"
        :current-branch="currentBranch"
        @changed="requestRefresh"
        @refresh-branches="requestRefresh"
        @worktree-from-branch="onWorktreeFromBranch"
        @conflict-detected="onConflictDetected"
      />
      <span class="control-divider" />
      <WorktreePanel
        ref="worktreePanelRef"
        :cwd="props.cwd"
        :branches="branches"
        :current-branch="currentBranch"
        @worktree-created="onWorktreeCreated"
        @changed="requestRefresh"
      />
      <GitOpsButtons
        ref="gitOpsRef"
        :cwd="props.cwd"
        :merge-status="mergeStatus"
        @changed="requestRefresh"
      />
      <DiffStatsButton :cwd="props.cwd" :diff-stats="diffStats" />
    </div>

    <div v-if="props.isRemote" class="remote-badge" :title="props.remoteLabel || 'SSH'">
      <Server :size="12" />
      <span>{{ props.remoteLabel || 'SSH' }}</span>
    </div>

    <!-- 任务运行 / IDE 启动:无论是否 git 都显示。语音输入只走快捷键(默认 F2),
         不再渲染按钮 —— 录音中浮在 pane 底部的 RecordingIndicator 就是反馈。 -->
    <div v-if="!props.isRemote" class="pane-toolbar-section pane-task-section">
      <TaskRunner
        :pane-id="props.paneId"
        :cwd="props.cwd"
        @manage-tasks="(cwd?: string, nd?: boolean) => emit('manageTasks', cwd, nd)"
      />
    </div>

    <div class="pane-toolbar-spacer" />

    <div class="pane-toolbar-section pane-action-section">
      <el-tooltip content="内置浏览器" placement="bottom" :show-after="300">
        <button class="browser-btn" @click="emit('toggleBrowser')">
          <Globe :size="14" />
        </button>
      </el-tooltip>
      <el-tooltip content="Agent 会话" placement="bottom" :show-after="300">
        <button class="session-btn" @click="emit('toggleAgentSessions')">
          <Bot :size="14" />
        </button>
      </el-tooltip>
      <IdeLauncher v-if="!props.isRemote" :cwd="props.cwd" />
    </div>
  </div>
</template>

<style scoped lang="scss" src="@renderer/assets/style/components/PaneToolbar.scss"></style>
