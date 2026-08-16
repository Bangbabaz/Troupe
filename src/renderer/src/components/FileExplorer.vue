<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, type LoadFunction, type TreeNodeData } from 'element-plus'
import {
  Clipboard,
  Copy,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  FolderSearch,
  FolderSync,
  LoaderCircle,
  RefreshCw,
  Search,
  Send,
  SquareTerminal
} from 'lucide-vue-next'
import type { FileBrowserEntry, FileGitStatus } from '@shared/types'
import IdeLauncher from './toolbar/IdeLauncher.vue'

const props = defineProps<{
  paneId: string
  root: string
  currentCwd: string
}>()

const emit = defineEmits<{
  openFile: [entry: FileBrowserEntry]
  workspaceRootChange: [root: string]
  sendPath: [payload: { absolutePath: string; relativePath: string; mode: 'absolute' | 'relative' }]
  openFolderPane: [path: string]
}>()

const treeVersion = ref(0)
const treeLoading = ref(false)
const treeError = ref('')
const query = ref('')
const searchResults = ref<FileBrowserEntry[]>([])
const searchLoading = ref(false)
const gitStatuses = ref<Record<string, FileGitStatus>>({})
const expandedPaths = ref(new Set<string>())
const contextEntry = ref<FileBrowserEntry | null>(null)
const contextPosition = ref({ left: 0, top: 0 })

let searchTimer: ReturnType<typeof setTimeout> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let searchGeneration = 0
let unsubscribeChanges: (() => void) | null = null

const rootName = computed(() => {
  const normalized = props.root.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || props.root
})
const expandedPathList = computed(() => Array.from(expandedPaths.value))
const canUseCurrentCwd = computed(
  () => !!props.currentCwd && normalizePath(props.currentCwd) !== normalizePath(props.root)
)

function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[A-Za-z]:/.test(normalized)) normalized = normalized.toLowerCase()
  return normalized
}

function fileIcon(entry: FileBrowserEntry): 'code' | 'image' | 'text' | 'file' {
  const extension = entry.name.split('.').pop()?.toLowerCase() || ''
  if (
    ['ts', 'tsx', 'js', 'jsx', 'vue', 'py', 'go', 'rs', 'java', 'css', 'scss', 'html'].includes(
      extension
    )
  ) {
    return 'code'
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(extension)) {
    return 'image'
  }
  if (['md', 'txt', 'json', 'yml', 'yaml', 'toml', 'ini', 'log'].includes(extension)) {
    return 'text'
  }
  return 'file'
}

function statusLabel(status: FileGitStatus | undefined): string {
  if (!status) return ''
  return {
    modified: 'M',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    untracked: '?',
    conflict: '!'
  }[status]
}

const loadNode: LoadFunction = async (node, resolveChildren) => {
  const entry = node.data as FileBrowserEntry | undefined
  const relativePath = node.level === 0 ? '' : entry?.relativePath || ''
  if (entry?.blocked) {
    resolveChildren([])
    return
  }
  if (node.level === 0) {
    treeLoading.value = true
    treeError.value = ''
  }
  try {
    resolveChildren(await window.api.fileBrowserList(props.root, relativePath))
  } catch (error) {
    resolveChildren([])
    treeError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (node.level === 0) treeLoading.value = false
  }
}

function isLeaf(data: TreeNodeData): boolean {
  const entry = data as FileBrowserEntry
  return entry.kind === 'file' || entry.blocked
}

async function refreshGitStatus(): Promise<void> {
  if (!props.root) return
  gitStatuses.value = await window.api.fileBrowserGitStatus(props.root).catch(() => ({}))
}

function refreshTree(): void {
  treeVersion.value++
  void refreshGitStatus()
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    refreshTree()
    if (query.value.trim()) void runSearch()
  }, 180)
}

async function runSearch(): Promise<void> {
  const value = query.value.trim()
  const generation = ++searchGeneration
  if (!value) {
    searchResults.value = []
    searchLoading.value = false
    return
  }
  searchLoading.value = true
  try {
    const results = await window.api.fileBrowserSearch(props.root, value)
    if (generation === searchGeneration) searchResults.value = results
  } catch (error) {
    if (generation === searchGeneration) {
      searchResults.value = []
      ElMessage.error(error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (generation === searchGeneration) searchLoading.value = false
  }
}

function onEntryClick(entry: FileBrowserEntry): void {
  if (entry.kind === 'file' && !entry.blocked) emit('openFile', entry)
}

function onExpand(entry: FileBrowserEntry): void {
  expandedPaths.value = new Set(expandedPaths.value).add(entry.relativePath)
}

function onCollapse(entry: FileBrowserEntry): void {
  const next = new Set(expandedPaths.value)
  next.delete(entry.relativePath)
  expandedPaths.value = next
}

function openContextMenu(event: Event, entry: FileBrowserEntry): void {
  event.preventDefault()
  event.stopPropagation()
  const pointerEvent = event as MouseEvent
  contextEntry.value = entry
  contextPosition.value = {
    left: Math.max(4, Math.min(pointerEvent.clientX, window.innerWidth - 260)),
    top: Math.max(4, Math.min(pointerEvent.clientY, window.innerHeight - 330))
  }
}

function closeContextMenu(): void {
  contextEntry.value = null
}

async function withContext(
  action: (entry: FileBrowserEntry) => Promise<void> | void
): Promise<void> {
  const entry = contextEntry.value
  closeContextMenu()
  if (!entry) return
  try {
    await action(entry)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

function copyAbsolutePath(): void {
  void withContext(async (entry) => {
    await navigator.clipboard.writeText(entry.absolutePath)
    ElMessage.success('已复制绝对路径')
  })
}

function copyRelativePath(): void {
  void withContext(async (entry) => {
    await navigator.clipboard.writeText(entry.relativePath)
    ElMessage.success('已复制相对路径')
  })
}

function revealInFileManager(): void {
  void withContext(async (entry) => {
    await window.api.fileBrowserReveal(props.root, entry.relativePath)
  })
}

function sendPath(mode: 'absolute' | 'relative'): void {
  void withContext((entry) => {
    emit('sendPath', {
      absolutePath: entry.absolutePath,
      relativePath: entry.relativePath,
      mode
    })
  })
}

function useCurrentCwd(): void {
  if (canUseCurrentCwd.value) emit('workspaceRootChange', props.currentCwd)
}

async function chooseWorkspaceRoot(): Promise<void> {
  const directory = await window.api.selectDirectory()
  if (directory) emit('workspaceRootChange', directory)
}

async function restartForRoot(): Promise<void> {
  expandedPaths.value = new Set()
  query.value = ''
  searchResults.value = []
  treeError.value = ''
  refreshTree()
  await window.api.fileBrowserWatchStop(props.paneId).catch(() => {})
  if (props.root) await window.api.fileBrowserWatchStart(props.paneId, props.root).catch(() => {})
}

watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    void runSearch()
  }, 180)
})

watch(
  () => props.root,
  () => void restartForRoot()
)

onMounted(() => {
  unsubscribeChanges = window.api.onFileBrowserChanged((payload) => {
    if (payload.paneId === props.paneId) scheduleRefresh()
  })
  void restartForRoot()
})

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
  if (refreshTimer) clearTimeout(refreshTimer)
  unsubscribeChanges?.()
  void window.api.fileBrowserWatchStop(props.paneId).catch(() => {})
})

defineExpose({ refresh: refreshTree })
</script>

<template>
  <div class="file-explorer">
    <div class="file-explorer-root">
      <FolderOpen :size="14" />
      <span :title="props.root">{{ rootName }}</span>
      <button v-if="canUseCurrentCwd" title="将当前终端目录设为工作区根目录" @click="useCurrentCwd">
        <FolderSync :size="13" />
      </button>
      <button title="选择工作区根目录" @click="chooseWorkspaceRoot">
        <FolderSearch :size="13" />
      </button>
      <button title="刷新文件树" @click="refreshTree"><RefreshCw :size="13" /></button>
    </div>

    <label class="file-explorer-search">
      <Search :size="13" />
      <input v-model="query" type="search" placeholder="搜索文件" spellcheck="false" />
      <LoaderCircle v-if="searchLoading" class="is-spinning" :size="13" />
    </label>

    <div v-if="query.trim()" class="file-search-results">
      <button
        v-for="entry in searchResults"
        :key="entry.relativePath"
        class="file-search-row"
        :title="entry.absolutePath"
        @click="onEntryClick(entry)"
        @contextmenu="openContextMenu($event, entry)"
      >
        <FileCode2 v-if="fileIcon(entry) === 'code'" :size="14" />
        <FileImage v-else-if="fileIcon(entry) === 'image'" :size="14" />
        <FileText v-else-if="fileIcon(entry) === 'text'" :size="14" />
        <File v-else :size="14" />
        <span>{{ entry.relativePath }}</span>
        <b v-if="gitStatuses[entry.relativePath]" :class="`is-${gitStatuses[entry.relativePath]}`">
          {{ statusLabel(gitStatuses[entry.relativePath]) }}
        </b>
      </button>
      <div v-if="!searchLoading && !searchResults.length" class="file-explorer-empty">
        未找到文件
      </div>
    </div>

    <div v-else class="file-explorer-tree-wrap">
      <div v-if="treeLoading" class="file-explorer-loading">
        <LoaderCircle class="is-spinning" :size="15" />
      </div>
      <el-tree
        :key="treeVersion"
        class="file-explorer-tree"
        node-key="relativePath"
        lazy
        :load="loadNode"
        :props="{
          label: 'name',
          isLeaf
        }"
        :default-expanded-keys="expandedPathList"
        :expand-on-click-node="true"
        @node-click="onEntryClick"
        @node-expand="onExpand"
        @node-collapse="onCollapse"
        @node-contextmenu="openContextMenu"
      >
        <template #default="{ data: entry }: { data: FileBrowserEntry }">
          <span
            class="file-tree-row"
            :class="{ 'is-blocked': entry.blocked }"
            :title="entry.absolutePath"
          >
            <Folder v-if="entry.kind === 'directory'" :size="14" />
            <FileCode2 v-else-if="fileIcon(entry) === 'code'" :size="14" />
            <FileImage v-else-if="fileIcon(entry) === 'image'" :size="14" />
            <FileText v-else-if="fileIcon(entry) === 'text'" :size="14" />
            <File v-else :size="14" />
            <span>{{ entry.name }}</span>
            <b
              v-if="gitStatuses[entry.relativePath]"
              :class="`is-${gitStatuses[entry.relativePath]}`"
            >
              {{ statusLabel(gitStatuses[entry.relativePath]) }}
            </b>
          </span>
        </template>
      </el-tree>
      <div v-if="treeError" class="file-explorer-empty is-error">{{ treeError }}</div>
    </div>

    <Teleport to="body">
      <div
        v-if="contextEntry"
        class="file-context-backdrop"
        @mousedown="closeContextMenu"
        @contextmenu.prevent="closeContextMenu"
      >
        <div
          class="file-context-menu"
          :style="{ left: `${contextPosition.left}px`, top: `${contextPosition.top}px` }"
          @mousedown.stop
        >
          <button
            v-if="contextEntry.kind === 'file'"
            @click="withContext((entry) => emit('openFile', entry))"
          >
            <FileText :size="14" /><span>在侧栏中打开</span>
          </button>
          <IdeLauncher
            :pane-id="props.paneId"
            :cwd="contextEntry.absolutePath"
            :target-kind="contextEntry.kind"
            variant="context"
            @opened="closeContextMenu"
          />
          <button @click="revealInFileManager">
            <FolderSearch :size="14" /><span>在文件管理器中显示</span>
          </button>
          <button
            v-if="contextEntry.kind === 'directory'"
            @click="withContext((entry) => emit('openFolderPane', entry.absolutePath))"
          >
            <SquareTerminal :size="14" /><span>打开为新面板</span>
          </button>
          <div class="file-context-divider"></div>
          <button @click="sendPath('absolute')">
            <Send :size="14" /><span>发送绝对路径到终端</span>
          </button>
          <button @click="sendPath('relative')">
            <Send :size="14" /><span>发送相对路径到终端</span>
          </button>
          <div class="file-context-divider"></div>
          <button @click="copyAbsolutePath">
            <Clipboard :size="14" /><span>复制绝对路径</span>
          </button>
          <button @click="copyRelativePath"><Copy :size="14" /><span>复制相对路径</span></button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped lang="scss" src="@renderer/assets/style/components/FileExplorer.scss"></style>
