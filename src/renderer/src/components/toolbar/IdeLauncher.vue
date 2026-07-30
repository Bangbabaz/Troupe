<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { ChevronDown, FolderClosed, RefreshCw, SquareTerminal } from 'lucide-vue-next'
import { iconFor } from '../ideIcons'
import { useIdes } from '../../composables/useIdes'

// "在 IDE 中打开"控件 —— 左边一个品牌色 chip(打开当前面板选择的 IDE)+ 右边小 caret
// (下拉切换 IDE)。每个面板的选择按 paneId 独立持久化。
//
// **不依赖 git** —— 任何 cwd 都能用,PaneToolbar 在 isRepo / 非 isRepo 时都
// 渲染。

const props = defineProps<{
  paneId: string
  cwd: string
}>()

const {
  ides,
  loading: ideLoading,
  selectedIde,
  init: initIdes,
  load: loadIdes,
  setSelected
} = useIdes(props.paneId)

const selectedIdeIcon = computed(() =>
  selectedIde.value ? iconFor(selectedIde.value.id, selectedIde.value.name) : null
)

onMounted(() => void initIdes())

async function openWithIde(id: string): Promise<void> {
  if (!props.cwd) return
  await initIdes()
  const r = await window.api.ideOpen(id, props.cwd)
  if (!r.success) {
    ElMessage.error(r.error || '打开 IDE 失败')
    return
  }
  setSelected(id)
}

const openSelectedIde = async (): Promise<void> => {
  await initIdes()
  if (!selectedIde.value) return
  await openWithIde(selectedIde.value.id)
}

const onPickIde = async (cmd: string): Promise<void> => {
  if (cmd === '__refresh__') {
    const list = await loadIdes(true)
    ElMessage.success(list.length ? `检测到 ${list.length} 个打开方式` : '未检测到打开方式')
    return
  }
  await openWithIde(cmd)
}
</script>

<template>
  <div class="ide-group">
    <el-tooltip
      :content="selectedIde ? `在 ${selectedIde.name} 中打开` : '在文件管理器中打开'"
      placement="bottom"
      :show-after="300"
    >
      <button
        class="ide-chip"
        :class="{ 'has-real-icon': !!selectedIde?.iconDataUrl }"
        :disabled="ideLoading"
        :style="
          selectedIde?.iconDataUrl
            ? undefined
            : selectedIdeIcon
              ? { color: selectedIdeIcon.color }
              : undefined
        "
        @click="openSelectedIde"
      >
        <img
          v-if="selectedIde?.iconDataUrl"
          class="ide-chip-img"
          :src="selectedIde.iconDataUrl"
          alt=""
          draggable="false"
        />
        <SquareTerminal v-else-if="selectedIde?.id === 'os-terminal'" :size="12" />
        <svg
          v-else-if="selectedIdeIcon && selectedIdeIcon.path"
          class="ide-chip-svg"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path :d="selectedIdeIcon.path" fill="currentColor" />
        </svg>
        <span v-else-if="selectedIdeIcon" class="ide-chip-letter">
          {{ selectedIdeIcon.letter }}
        </span>
        <FolderClosed v-else :size="13" />
      </button>
    </el-tooltip>
    <el-dropdown
      trigger="click"
      placement="bottom-end"
      popper-class="ide-pick-dropdown"
      @command="onPickIde"
    >
      <button class="ide-caret" :disabled="ideLoading" title="切换 IDE">
        <ChevronDown :size="12" />
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="ide in ides"
            :key="ide.id"
            :command="ide.id"
            :title="ide.command"
            :class="{ picked: ide.id === selectedIde?.id }"
          >
            <span
              class="ide-row-icon"
              :class="{ 'has-real-icon': !!ide.iconDataUrl }"
              :style="ide.iconDataUrl ? undefined : { background: iconFor(ide.id, ide.name).color }"
            >
              <img v-if="ide.iconDataUrl" :src="ide.iconDataUrl" alt="" draggable="false" />
              <SquareTerminal v-else-if="ide.id === 'os-terminal'" :size="12" />
              <svg
                v-else-if="iconFor(ide.id, ide.name).path"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path :d="iconFor(ide.id, ide.name).path" fill="#fff" />
              </svg>
              <span v-else class="ide-row-letter">
                {{ iconFor(ide.id, ide.name).letter }}
              </span>
            </span>
            <span class="td-label">{{ ide.name }}</span>
          </el-dropdown-item>
          <el-dropdown-item v-if="!ides.length" disabled class="cmd-empty">
            未检测到 IDE
          </el-dropdown-item>
          <el-dropdown-item divided command="__refresh__">
            <RefreshCw :size="12" style="margin-right: 6px" />
            重新检测
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<style scoped lang="scss" src="@renderer/assets/style/components/toolbar/IdeLauncher.scss"></style>
