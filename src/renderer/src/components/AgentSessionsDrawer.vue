<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Bot, Clock3, RefreshCw } from 'lucide-vue-next'
import type { AgentSessionInfo, AgentSessionProvider } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  filterCwd?: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'openSession', session: AgentSessionInfo): void
}>()

const loading = ref(false)
const sessions = ref<AgentSessionInfo[]>([])
const provider = ref<'all' | AgentSessionProvider>('all')

function normPath(p: string | null | undefined): string {
  if (!p) return ''
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase()
  return s
}

function pathMatchesScope(sessionCwd: string | null, scopeCwd: string): boolean {
  const sessionPath = normPath(sessionCwd)
  if (!sessionPath || !scopeCwd) return false
  if (sessionPath === scopeCwd) return true
  return sessionPath.startsWith(`${scopeCwd}/`) || scopeCwd.startsWith(`${sessionPath}/`)
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    sessions.value = await window.api.agentSessionsList()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ElMessage.error(`读取会话失败: ${msg}`)
  } finally {
    loading.value = false
  }
}

const filtered = computed(() => {
  const cwd = normPath(props.filterCwd)
  const seen = new Set<string>()
  return sessions.value.filter((session) => {
    const key = `${session.provider}:${session.id}`
    if (seen.has(key)) return false
    seen.add(key)
    if (provider.value !== 'all' && session.provider !== provider.value) return false
    if (cwd && !pathMatchesScope(session.cwd, cwd)) return false
    return true
  })
})

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString()
}

function openSession(session: AgentSessionInfo): void {
  emit('openSession', session)
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) void refresh()
  }
)

watch(
  () => props.filterCwd,
  () => {
    provider.value = 'all'
    if (props.modelValue) void refresh()
  }
)

onMounted(() => {
  if (props.modelValue) void refresh()
})
</script>

<template>
  <aside v-if="modelValue" class="agent-sessions-panel">
    <header class="agent-panel-header">
      <div class="agent-panel-heading">
        <span class="agent-panel-icon"><Bot :size="15" /></span>
        <div>
          <div class="agent-panel-title">Agent 会话</div>
          <div class="agent-panel-subtitle">{{ filtered.length }} 个可恢复会话</div>
        </div>
      </div>
      <button class="agent-refresh" title="刷新会话" :disabled="loading" @click="refresh">
        <RefreshCw :size="13" :class="{ spinning: loading }" />
      </button>
    </header>

    <div class="agent-session-toolbar">
      <el-radio-group v-model="provider" size="small" class="agent-session-provider-filter">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="claude">Claude</el-radio-button>
        <el-radio-button value="codex">Codex</el-radio-button>
      </el-radio-group>
    </div>

    <div v-if="loading && sessions.length === 0" class="agent-session-empty">读取中...</div>
    <div v-else-if="filtered.length === 0" class="agent-session-empty">没有会话</div>
    <div v-else class="agent-session-list">
      <button
        v-for="session in filtered"
        :key="`${session.provider}:${session.id}`"
        class="agent-session-row"
        :title="session.title"
        @click="openSession(session)"
      >
        <span class="agent-session-content">
          <span class="agent-session-title">{{ session.title }}</span>
          <span class="agent-session-meta">
            <span class="agent-provider-name">{{ session.provider }}</span>
            <span class="agent-session-time">
              <Clock3 :size="10" />{{ relativeTime(session.updatedAt) }}
            </span>
          </span>
        </span>
      </button>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.agent-sessions-panel {
  width: 310px;
  min-width: 240px;
  max-width: 380px;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 12px 10px;
  overflow: hidden;
  border-right: 1px solid var(--el-border-color);
  background: var(--el-bg-color-page);
  flex-shrink: 0;
  @include ui-font;
}

.agent-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 38px;
  margin-bottom: 12px;
  padding: 0 2px;
}

.agent-panel-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.agent-panel-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid color-mix(in srgb, var(--el-color-primary) 35%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  color: var(--el-color-primary);
}

.agent-panel-title {
  color: var(--el-text-color-primary);
  font-size: 12px;
  font-weight: 700;
}

.agent-panel-subtitle {
  margin-top: 1px;
  color: var(--el-text-color-placeholder);
  font-size: 10px;
}

.agent-refresh {
  @include toolbar-icon-button(28px);
  border: 1px solid var(--el-border-color-light);
  background: var(--el-bg-color);
}

.spinning {
  animation: agent-spin 0.8s linear infinite;
}

@keyframes agent-spin {
  to {
    transform: rotate(360deg);
  }
}

.agent-session-toolbar {
  margin-bottom: 9px;
  padding: 3px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.agent-session-provider-filter {
  width: 100%;

  :deep(.el-radio-button) {
    flex: 1;
  }

  :deep(.el-radio-button__inner) {
    width: 100%;
    min-height: 26px;
    padding: 7px 4px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    box-shadow: none;
    color: var(--el-text-color-secondary);
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
  }

  :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
    background: var(--el-fill-color);
    color: var(--el-text-color-primary);
    box-shadow: none;
  }
}

.agent-session-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow-x: hidden;
  overflow-y: auto;
}

.agent-session-row {
  @include btn-reset;
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  min-height: 48px;
  padding: 8px 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  text-align: left;
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease;

  &:hover {
    border-color: var(--el-border-color-dark);
    background: var(--el-bg-color-overlay);
  }
}

.agent-session-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.agent-session-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  color: var(--el-text-color-secondary);
  font-size: 9.5px;
}

.agent-session-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 11.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-session-time {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--el-text-color-placeholder);
  font-size: 9px;
  white-space: nowrap;
  flex-shrink: 0;
}

.agent-provider-name {
  color: var(--el-text-color-placeholder);
  font-size: 8px;
  text-transform: uppercase;
}

.agent-session-empty {
  padding: 40px 10px;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  text-align: center;
}
</style>
