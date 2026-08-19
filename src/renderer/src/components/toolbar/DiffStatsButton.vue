<script setup lang="ts">
import { ref } from 'vue'
import DiffViewer from '../DiffViewer.vue'
import type { DiffStats } from '@shared/types'

// 工作区改动统计 chip(+N -N)。点击展开 diff dialog。
//
// 从 GitOpsButtons 拆出来,因为它要锚在工具栏最右(用户体感:"行数统计在最末,
// 跟 IDE 按钮分开"),与 history / merge badge 的位置正好相反。

const props = defineProps<{
  cwd: string
  diffStats: DiffStats
}>()

const showDiff = ref(false)
const diffLoading = ref(false)
const diffText = ref('')
const diffEmpty = ref(false)
const diffTruncated = ref(false)

function fetchDiffContent(side: 'old' | 'new', path: string): Promise<string | null> {
  return window.api.gitShowFile(props.cwd, side === 'old' ? 'HEAD' : null, path)
}

async function openDiff(): Promise<void> {
  showDiff.value = true
  diffLoading.value = true
  diffText.value = ''
  diffEmpty.value = false
  diffTruncated.value = false
  try {
    const { diff, truncated } = await window.api.gitDiff(props.cwd)
    diffTruncated.value = truncated
    if (!diff.trim()) {
      diffEmpty.value = true
      return
    }
    diffText.value = diff
  } catch {
    diffEmpty.value = true
  } finally {
    diffLoading.value = false
  }
}

defineExpose({ openDiff })
</script>

<template>
  <button
    v-if="diffStats.files"
    class="diff-stats"
    title="查看改动 (diff)"
    aria-label="查看改动 (diff)"
    @click="openDiff"
  >
    <span v-if="diffStats.added" class="diff-added">+{{ diffStats.added }}</span>
    <span v-if="diffStats.deleted" class="diff-deleted">-{{ diffStats.deleted }}</span>
    <span v-if="!diffStats.added && !diffStats.deleted" class="diff-files">
      {{ diffStats.files }} 个文件
    </span>
  </button>

  <el-dialog
    v-model="showDiff"
    title="改动"
    width="92%"
    align-center
    class="diff-dialog"
    :lock-scroll="true"
    :close-on-click-modal="false"
  >
    <div v-if="diffLoading" class="diff-state">加载中…</div>
    <div v-else-if="diffEmpty" class="diff-state">没有改动</div>
    <template v-else>
      <div v-if="diffTruncated" class="diff-trunc">改动过大,仅显示前 10 MB</div>
      <DiffViewer :diff="diffText" :fetch-content="fetchDiffContent" />
    </template>
    <template #footer>
      <el-button size="small" @click="showDiff = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style
  scoped
  lang="scss"
  src="@renderer/assets/style/components/toolbar/DiffStatsButton.scss"
></style>
