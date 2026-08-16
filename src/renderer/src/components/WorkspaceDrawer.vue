<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronRight, Files, Globe, X } from 'lucide-vue-next'
import type { FileBrowserEntry } from '@shared/types'
import BrowserDrawer from './BrowserDrawer.vue'
import FileExplorer from './FileExplorer.vue'
import FilePreview from './FilePreview.vue'

const props = defineProps<{
  paneId: string
  root: string
  currentCwd: string
  browserMounted: boolean
  filesEnabled: boolean
}>()

const emit = defineEmits<{
  collapse: []
  closeBrowser: []
  activeChange: [kind: 'files' | 'file' | 'browser']
  workspaceRootChange: [root: string]
  sendPath: [payload: { absolutePath: string; relativePath: string; mode: 'absolute' | 'relative' }]
  openFolderPane: [path: string]
}>()

interface OpenFileTab {
  path: string
  label: string
}

const FILES_TAB = 'files'
const BROWSER_TAB = 'browser'
const activeTab = ref(FILES_TAB)
const openFiles = ref<OpenFileTab[]>([])
const explorerRef = ref<InstanceType<typeof FileExplorer>>()

const activeFilePath = computed(() =>
  activeTab.value.startsWith('file:') ? activeTab.value.slice(5) : ''
)

function tabId(path: string): string {
  return `file:${path}`
}

function openFile(entry: FileBrowserEntry): void {
  if (!openFiles.value.some((tab) => tab.path === entry.relativePath)) {
    openFiles.value.push({ path: entry.relativePath, label: entry.name })
  }
  activeTab.value = tabId(entry.relativePath)
}

function closeFile(path: string): void {
  const index = openFiles.value.findIndex((tab) => tab.path === path)
  if (index < 0) return
  const wasActive = activeTab.value === tabId(path)
  openFiles.value.splice(index, 1)
  if (wasActive) {
    const next = openFiles.value[Math.min(index, openFiles.value.length - 1)]
    activeTab.value = next ? tabId(next.path) : FILES_TAB
  }
}

function closeBrowser(): void {
  emit('closeBrowser')
  if (activeTab.value !== BROWSER_TAB) return
  if (props.filesEnabled) activeTab.value = FILES_TAB
  else emit('collapse')
}

function showFiles(): void {
  if (!props.filesEnabled) return
  activeTab.value = FILES_TAB
  explorerRef.value?.refresh()
}

function showBrowser(): void {
  activeTab.value = BROWSER_TAB
}

watch(
  activeTab,
  (tab) =>
    emit('activeChange', tab === FILES_TAB ? 'files' : tab === BROWSER_TAB ? 'browser' : 'file'),
  { immediate: true }
)

watch(
  () => props.browserMounted,
  (mounted) => {
    if (!mounted && activeTab.value === BROWSER_TAB) activeTab.value = FILES_TAB
  }
)

watch(
  () => props.root,
  () => {
    if (!props.filesEnabled) return
    openFiles.value = []
    activeTab.value = FILES_TAB
  }
)

defineExpose({ showFiles, showBrowser })
</script>

<template>
  <div class="workspace-drawer" @click.stop>
    <div class="workspace-tabs">
      <button
        v-if="props.filesEnabled"
        class="workspace-tab workspace-tab-fixed"
        :class="{ 'is-active': activeTab === FILES_TAB }"
        title="文件"
        @click="showFiles"
      >
        <Files :size="13" />
        <span>文件</span>
      </button>

      <div class="workspace-file-tabs">
        <button
          v-for="tab in openFiles"
          :key="tab.path"
          class="workspace-tab workspace-file-tab"
          :class="{ 'is-active': activeTab === tabId(tab.path) }"
          :title="tab.path"
          @click="activeTab = tabId(tab.path)"
        >
          <span>{{ tab.label }}</span>
          <i title="关闭文件" @click.stop="closeFile(tab.path)"><X :size="11" /></i>
        </button>
      </div>

      <button
        v-if="props.browserMounted"
        class="workspace-tab workspace-tab-fixed"
        :class="{ 'is-active': activeTab === BROWSER_TAB }"
        title="浏览器"
        @click="showBrowser"
      >
        <Globe :size="13" />
        <span>浏览器</span>
        <i title="关闭浏览器" @click.stop="closeBrowser"><X :size="11" /></i>
      </button>

      <button class="workspace-collapse" title="收起侧栏" @click="emit('collapse')">
        <ChevronRight :size="14" />
      </button>
    </div>

    <div class="workspace-drawer-content">
      <FileExplorer
        v-if="props.filesEnabled"
        v-show="activeTab === FILES_TAB"
        ref="explorerRef"
        :pane-id="props.paneId"
        :root="props.root"
        :current-cwd="props.currentCwd"
        @open-file="openFile"
        @workspace-root-change="emit('workspaceRootChange', $event)"
        @send-path="emit('sendPath', $event)"
        @open-folder-pane="emit('openFolderPane', $event)"
      />
      <FilePreview
        v-if="activeFilePath"
        v-show="activeTab.startsWith('file:')"
        :pane-id="props.paneId"
        :root="props.root"
        :path="activeFilePath"
      />
      <BrowserDrawer
        v-if="props.browserMounted"
        v-show="activeTab === BROWSER_TAB"
        embedded
        :pane-id="props.paneId"
      />
    </div>
  </div>
</template>

<style scoped lang="scss" src="@renderer/assets/style/components/WorkspaceDrawer.scss"></style>
