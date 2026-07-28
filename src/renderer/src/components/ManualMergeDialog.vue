<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { ConflictedFile, ConflictVersions } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  cwd: string
  file: ConflictedFile | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved'): void
}>()

const versions = ref<ConflictVersions | null>(null)
const result = ref('')
const loading = ref(false)
const saving = ref(false)

watch(
  () => [props.modelValue, props.file?.path] as const,
  async ([open]) => {
    if (!open || !props.file) return
    loading.value = true
    try {
      versions.value = await window.api.gitConflictVersions(props.cwd, props.file.path)
      result.value = versions.value.working ?? versions.value.ours ?? versions.value.theirs ?? ''
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)

function useVersion(content: string | null): void {
  if (content !== null) result.value = content
}

async function save(): Promise<void> {
  if (!props.file) return
  if (/^(<{7}|={7}|>{7})/m.test(result.value)) {
    ElMessage.warning('合并结果中仍有冲突标记，请处理后再应用')
    return
  }
  saving.value = true
  try {
    const r = await window.api.gitConflictSave(props.cwd, props.file.path, result.value)
    if (!r.success) {
      ElMessage.error(r.error || '保存合并结果失败')
      return
    }
    ElMessage.success('合并结果已保存并标记为解决')
    emit('saved')
    emit('update:modelValue', false)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="file ? `手动合并 · ${file.path}` : '手动合并'"
    width="96%"
    top="3vh"
    class="manual-merge-dialog"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div v-loading="loading" class="mm-root">
      <div class="mm-sources">
        <section class="mm-pane">
          <header>
            <b>我方</b>
            <el-button
              size="small"
              :disabled="versions?.ours == null"
              @click="useVersion(versions?.ours ?? null)"
            >
              使用我方作为结果
            </el-button>
          </header>
          <textarea
            :value="versions?.ours ?? '（该版本中不存在此文件）'"
            readonly
            spellcheck="false"
          />
        </section>
        <section class="mm-pane mm-base">
          <header><b>共同祖先</b></header>
          <textarea :value="versions?.base ?? '（无共同祖先版本）'" readonly spellcheck="false" />
        </section>
        <section class="mm-pane">
          <header>
            <b>对方</b>
            <el-button
              size="small"
              :disabled="versions?.theirs == null"
              @click="useVersion(versions?.theirs ?? null)"
            >
              使用对方作为结果
            </el-button>
          </header>
          <textarea
            :value="versions?.theirs ?? '（该版本中不存在此文件）'"
            readonly
            spellcheck="false"
          />
        </section>
      </div>
      <section class="mm-result">
        <header>
          <b>合并结果</b>
          <span>请编辑最终内容，并确保移除所有冲突标记</span>
        </header>
        <textarea v-model="result" spellcheck="false" />
      </section>
    </div>
    <template #footer>
      <el-button size="small" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button size="small" type="primary" :loading="saving" @click="save"
        >应用并标记已解决</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.mm-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mm-sources {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 0.8fr 1fr;
  gap: 10px;
}

.mm-pane,
.mm-result {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--el-border-color);
  border-radius: 7px;
  background: var(--el-bg-color);
  overflow: hidden;
}

header {
  height: 38px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-bottom: 1px solid var(--el-border-color-light);
  background: var(--el-bg-color-overlay);
  font-size: 11px;
  flex-shrink: 0;
}

header b {
  color: var(--el-text-color-primary);
  font-weight: 700;
}

header .el-button {
  margin-left: auto;
}

header span {
  color: var(--el-text-color-secondary);
}

textarea {
  min-height: 0;
  padding: 14px;
  border: 0;
  outline: 0;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-primary);
  font:
    12px/1.6 'Cascadia Code',
    Consolas,
    monospace;
  resize: none;
  white-space: pre;
  overflow: auto;
  flex: 1;
}

.mm-result {
  flex: 1;
  border-color: color-mix(in srgb, var(--el-color-primary) 35%, var(--el-border-color));
}

.mm-result header {
  box-shadow: inset 3px 0 0 var(--el-color-primary);
}

.mm-result textarea {
  background: var(--el-bg-color);
}
</style>
