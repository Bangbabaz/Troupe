<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Binary,
  Copy,
  FileWarning,
  FolderSearch,
  Image as ImageIcon,
  LoaderCircle
} from 'lucide-vue-next'
import type { FileBrowserPreview } from '@shared/types'
import { detectFileLanguage } from '../lib/fileLanguage'
import ShikiWorker from '../workers/shiki.worker?worker'
import IdeLauncher from './toolbar/IdeLauncher.vue'

const props = defineProps<{
  paneId: string
  root: string
  path: string
}>()

const preview = ref<FileBrowserPreview | null>(null)
const loading = ref(false)
const error = ref('')
const highlightedLines = ref<string[] | null>(null)
let loadGeneration = 0

const worker = new ShikiWorker()
let workerSequence = 0
let workerAlive = true
const pending = new Map<number, (lines: string[] | null) => void>()

worker.addEventListener(
  'message',
  (event: MessageEvent<{ id: number; lines: string[] | null }>) => {
    const resolve = pending.get(event.data.id)
    if (!resolve) return
    pending.delete(event.data.id)
    resolve(event.data.lines)
  }
)

function tokenize(content: string, language: string): Promise<string[] | null> {
  if (!workerAlive) return Promise.resolve(null)
  return new Promise((resolve) => {
    const id = ++workerSequence
    pending.set(id, resolve)
    worker.postMessage({ id, content, lang: language })
  })
}

const plainLines = computed(() => preview.value?.content?.split(/\r?\n/) || [])

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function loadPreview(): Promise<void> {
  const generation = ++loadGeneration
  loading.value = true
  error.value = ''
  preview.value = null
  highlightedLines.value = null
  try {
    const result = await window.api.fileBrowserPreview(props.root, props.path)
    if (generation !== loadGeneration) return
    preview.value = result
    if (result.kind !== 'text' || !result.content) return
    const language = detectFileLanguage(result.relativePath)
    if (!language) return
    const lines = await tokenize(result.content, language)
    if (generation === loadGeneration) highlightedLines.value = lines
  } catch (loadError) {
    if (generation === loadGeneration) {
      error.value = loadError instanceof Error ? loadError.message : String(loadError)
    }
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

async function copyPath(): Promise<void> {
  if (!preview.value) return
  await navigator.clipboard.writeText(preview.value.absolutePath)
  ElMessage.success('已复制绝对路径')
}

async function revealFile(): Promise<void> {
  await window.api.fileBrowserReveal(props.root, props.path)
}

watch(() => [props.root, props.path], loadPreview, { immediate: true })

onBeforeUnmount(() => {
  workerAlive = false
  for (const resolve of pending.values()) resolve(null)
  pending.clear()
  worker.terminate()
})
</script>

<template>
  <div class="file-preview">
    <div class="file-preview-header">
      <div class="file-preview-path" :title="preview?.absolutePath || props.path">
        {{ preview?.relativePath || props.path }}
      </div>
      <div class="file-preview-actions">
        <button title="复制绝对路径" @click="copyPath"><Copy :size="13" /></button>
        <button title="在文件管理器中显示" @click="revealFile">
          <FolderSearch :size="13" />
        </button>
        <IdeLauncher
          v-if="preview"
          :pane-id="props.paneId"
          :cwd="preview.absolutePath"
          target-kind="file"
        />
      </div>
    </div>

    <div v-if="loading" class="file-preview-state">
      <LoaderCircle class="is-spinning" :size="18" />
      <span>正在读取</span>
    </div>
    <div v-else-if="error" class="file-preview-state is-error">
      <FileWarning :size="20" />
      <span>{{ error }}</span>
    </div>
    <template v-else-if="preview">
      <div v-if="preview.kind === 'text'" class="file-preview-code-wrap">
        <div v-if="preview.truncated" class="file-preview-notice">
          文件较大，仅显示前 {{ formatSize(512 * 1024) }}
        </div>
        <div class="file-preview-code">
          <div v-for="(line, index) in plainLines" :key="index" class="file-preview-line">
            <span class="file-preview-line-number">{{ index + 1 }}</span>
            <!-- Shiki worker escapes source text before returning token spans. -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <code v-if="highlightedLines" v-html="highlightedLines[index] || ''"></code>
            <code v-else>{{ line }}</code>
          </div>
        </div>
      </div>
      <div v-else-if="preview.kind === 'image'" class="file-preview-image-wrap">
        <img :src="preview.dataUrl" :alt="preview.relativePath" />
        <span>{{ formatSize(preview.size) }}</span>
      </div>
      <div v-else class="file-preview-state">
        <ImageIcon v-if="preview.kind === 'external'" :size="22" />
        <Binary v-else-if="preview.kind === 'binary'" :size="22" />
        <FileWarning v-else :size="22" />
        <strong>
          {{
            preview.kind === 'external'
              ? '此文件使用外部应用预览'
              : preview.kind === 'binary'
                ? '二进制文件无法预览'
                : '文件过大，无法在侧栏中预览'
          }}
        </strong>
        <span>{{ formatSize(preview.size) }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss" src="@renderer/assets/style/components/FilePreview.scss"></style>

<style lang="scss">
[data-theme='light'] .file-preview-code span {
  color: var(--shiki-light) !important;
}
</style>
