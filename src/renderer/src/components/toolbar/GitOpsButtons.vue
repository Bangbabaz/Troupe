<script setup lang="ts">
import { computed, ref } from 'vue'
import { History, GitMerge } from 'lucide-vue-next'
import MergeStatusPanel from '../MergeStatusPanel.vue'
import GitLogViewer from '../GitLogViewer.vue'
import type { MergeStatus } from '@shared/types'

// 工具栏左侧的 git ops 入口:提交历史按钮 + merge/冲突 badge + 它们的弹窗 host。
// (diff stats 是单独 DiffStatsButton,挂在工具栏最右,与本组件分开。)

const props = defineProps<{
  cwd: string
  mergeStatus: MergeStatus | null
}>()

const emit = defineEmits<{
  /** 用户在 MergeStatusPanel 里执行了 abort/continue/resolve,父级需要 refresh。 */
  changed: []
}>()

const showLog = ref(false)
const showMerge = ref(false)

function openMergePanel(): void {
  showMerge.value = true
}

defineExpose({ openMergePanel })

const mergeBadgeLabel = computed(() => {
  const s = props.mergeStatus
  if (!s || (!s.inProgress && !s.conflicts.length)) return ''
  const opText =
    s.inProgress === 'merge'
      ? '合并'
      : s.inProgress === 'rebase'
        ? '变基'
        : s.inProgress === 'cherry-pick'
          ? 'cherry-pick'
          : s.inProgress === 'revert'
            ? 'revert'
            : '冲突'
  const target = s.target ? `(${s.target})` : ''
  return `${opText}进行中${target} — ${s.conflicts.length} 个冲突`
})

const mergeBadgeVisible = computed(() => {
  const s = props.mergeStatus
  return !!s && (!!s.inProgress || s.conflicts.length > 0)
})
</script>

<template>
  <el-tooltip content="提交历史" placement="bottom" :show-after="300">
    <button class="wt-btn icon" @click="showLog = true">
      <History :size="13" />
    </button>
  </el-tooltip>

  <el-tooltip
    v-if="mergeBadgeVisible"
    :content="mergeBadgeLabel"
    placement="bottom"
    :show-after="300"
  >
    <button class="merge-badge" @click="showMerge = true">
      <GitMerge :size="12" />
      <span class="merge-badge-count">{{ mergeStatus?.conflicts.length || 0 }}</span>
    </button>
  </el-tooltip>

  <el-dialog
    v-model="showMerge"
    title="合并 / 冲突"
    width="92%"
    align-center
    class="diff-dialog"
    :lock-scroll="true"
    :close-on-click-modal="false"
  >
    <MergeStatusPanel
      v-if="showMerge && cwd"
      :cwd="cwd"
      @changed="emit('changed')"
      @request-close="showMerge = false"
    />
    <template #footer>
      <el-button size="small" @click="showMerge = false">关闭</el-button>
    </template>
  </el-dialog>

  <el-dialog
    v-model="showLog"
    title="提交历史"
    width="92%"
    align-center
    class="diff-dialog"
    :lock-scroll="true"
    :close-on-click-modal="false"
  >
    <GitLogViewer v-if="showLog && cwd" :cwd="cwd" />
    <template #footer>
      <el-button size="small" @click="showLog = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style
  scoped
  lang="scss"
  src="@renderer/assets/style/components/toolbar/GitOpsButtons.scss"
></style>
