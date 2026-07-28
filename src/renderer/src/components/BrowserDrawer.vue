<!--
  浏览器抽屉组件 —— 每个终端面板底部可展开的内置浏览器。

  功能极简：导航栏 + webview，不做 DevTools / 调试 / 状态显示。
  挂载时通过 IPC 向 main process 注册 webContentsId，使 MCP server
  能通过 CDP 控制该 webview；卸载时注销。
-->
<template>
  <div class="browser-drawer">
    <!-- 导航栏 -->
    <div class="browser-nav">
      <button class="browser-nav-btn" title="后退" :disabled="!canGoBack" @click="goBack">
        <ChevronLeft :size="14" />
      </button>
      <button class="browser-nav-btn" title="前进" :disabled="!canGoForward" @click="goForward">
        <ChevronRight :size="14" />
      </button>
      <button class="browser-nav-btn" title="刷新" @click="reload">
        <RotateCw :size="12" />
      </button>
      <input
        ref="urlInputRef"
        class="browser-nav-url"
        type="text"
        :value="currentUrl"
        title="输入 URL 后回车导航"
        @keydown.enter="navigateToUrl"
      />
      <button
        class="browser-nav-btn"
        :class="{ 'is-active': proxyPanelOpen, 'has-proxy': proxyApplied }"
        title="CSS / JS 资源代理"
        @click="toggleProxyPanel"
      >
        <Network :size="13" />
      </button>
      <button class="browser-nav-btn" title="收起抽屉" @click="emit('collapse')">
        <Minus :size="14" />
      </button>
      <button class="browser-nav-close" title="关闭浏览器" @click="emit('close')">
        <X :size="14" />
      </button>
    </div>

    <div v-if="proxyPanelOpen" class="browser-proxy-panel">
      <div class="browser-proxy-heading">
        <span>CSS / JS 资源代理</span>
        <div class="browser-proxy-heading-actions">
          <div class="browser-proxy-inline-switch">
            <span>启用</span>
            <el-switch v-model="proxyDraft.enabled" size="small" />
          </div>
        </div>
      </div>
      <div class="browser-proxy-mapping">
        <label class="browser-proxy-field">
          <span>本地端口</span>
          <input
            v-model.number="proxyDraft.localPort"
            type="number"
            min="1"
            max="65535"
            step="1"
            placeholder="5173"
            @keydown.enter="applyProxyConfig"
          />
        </label>
      </div>
      <div class="browser-proxy-rules-heading">
        <span>子路径规则</span>
        <div class="browser-proxy-default-action">
          <span>未匹配</span>
          <el-segmented
            v-model="proxyDraft.defaultAction"
            :options="proxyActionOptions"
            size="small"
          />
        </div>
      </div>
      <div class="browser-proxy-rules">
        <div v-for="(rule, index) in proxyDraft.rules" :key="rule.id" class="browser-proxy-rule">
          <label class="browser-proxy-field">
            <span>路径前缀</span>
            <input
              v-model.trim="rule.pathPrefix"
              type="text"
              placeholder="/assets/"
              spellcheck="false"
              @keydown.enter="applyProxyConfig"
            />
          </label>
          <el-switch
            v-model="rule.action"
            active-value="proxy"
            inactive-value="bypass"
            active-text="代理"
            inactive-text="不代理"
            size="small"
            class="browser-proxy-rule-action"
          />
          <button class="browser-proxy-delete" title="删除规则" @click="removeProxyRule(index)">
            <Trash2 :size="13" />
          </button>
        </div>
      </div>
      <div class="browser-proxy-actions">
        <button class="browser-proxy-tool" title="添加规则" @click="addProxyRule">
          <Plus :size="13" />
          <span>添加规则</span>
        </button>
        <div class="browser-proxy-actions-right">
          <div class="browser-proxy-inline-switch">
            <span>失败回退远端</span>
            <el-switch v-model="proxyDraft.fallbackToRemote" size="small" />
          </div>
          <button
            class="browser-proxy-apply"
            :disabled="proxySaving"
            title="应用并刷新"
            @click="applyProxyConfig"
          >
            <LoaderCircle v-if="proxySaving" class="is-spinning" :size="13" />
            <Check v-else :size="13" />
            <span>应用</span>
          </button>
        </div>
      </div>
      <div v-if="proxyError" class="browser-proxy-error" role="alert">{{ proxyError }}</div>
    </div>

    <!-- webview -->
    <div class="browser-webview-container">
      <webview
        ref="webviewRef"
        :src="initialUrl || 'about:blank'"
        :preload="''"
        :nodeintegration="false"
        :disablewebsecurity="false"
        :allowpopups="false"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted, onUnmounted } from 'vue'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Minus,
  Network,
  Plus,
  RotateCw,
  Trash2,
  X
} from 'lucide-vue-next'
import type { BrowserResourceProxyConfig, BrowserResourceProxyPathRule } from '@shared/types'

const props = withDefaults(
  defineProps<{
    paneId: string
    initialUrl?: string
  }>(),
  {
    initialUrl: 'about:blank'
  }
)

const emit = defineEmits<{
  close: []
  collapse: []
  ready: []
}>()

const webviewRef = ref<HTMLElement | null>(null)
const urlInputRef = ref<HTMLInputElement | null>(null)
const currentUrl = ref('about:blank')
const canGoBack = ref(false)
const canGoForward = ref(false)
const proxyPanelOpen = ref(false)
const proxySaving = ref(false)
const proxyError = ref('')
const proxyStorageKey = `troupe:browser-resource-proxy:${props.paneId}`
const legacyProxyStorageKey = `gittim:browser-resource-proxy:${props.paneId}`
const DEFAULT_LOCAL_PORT = 5173
const proxyActionOptions = [
  { label: '代理', value: 'proxy' },
  { label: '不代理', value: 'bypass' }
]
let proxyRuleSequence = 0

function createProxyRule(
  pathPrefix = '',
  action: BrowserResourceProxyPathRule['action'] = 'bypass'
): BrowserResourceProxyPathRule {
  proxyRuleSequence += 1
  return {
    id: `rule-${Date.now().toString(36)}-${proxyRuleSequence}`,
    pathPrefix,
    action
  }
}

function portFromStoredUrl(value: unknown): number | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    const port = url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

function loadProxyConfig(): BrowserResourceProxyConfig {
  const defaults: BrowserResourceProxyConfig = {
    enabled: false,
    localPort: DEFAULT_LOCAL_PORT,
    defaultAction: 'proxy',
    fallbackToRemote: true,
    rules: []
  }
  try {
    let stored = localStorage.getItem(proxyStorageKey)
    if (!stored) {
      stored = localStorage.getItem(legacyProxyStorageKey)
      if (stored) {
        localStorage.setItem(proxyStorageKey, stored)
        localStorage.removeItem(legacyProxyStorageKey)
      }
    }
    if (!stored) return defaults
    const parsed = JSON.parse(stored) as Record<string, unknown>
    const rawRules = Array.isArray(parsed.rules)
      ? parsed.rules.filter(
          (item): item is Record<string, unknown> => !!item && typeof item === 'object'
        )
      : []
    const storedRules = rawRules
      .filter((item) => typeof item.pathPrefix === 'string' && item.enabled !== false)
      .map((item) => ({
        id: typeof item.id === 'string' && item.id ? item.id : createProxyRule().id,
        pathPrefix: String(item.pathPrefix),
        action: item.action === 'bypass' ? ('bypass' as const) : ('proxy' as const)
      }))
    const previousMapping = rawRules.find((item) => typeof item.localUrlPrefix === 'string')
    const storedPort = Number(parsed.localPort)
    const localPort =
      Number.isInteger(storedPort) && storedPort >= 1 && storedPort <= 65535
        ? storedPort
        : (portFromStoredUrl(parsed.localUrlPrefix) ??
          portFromStoredUrl(previousMapping?.localUrlPrefix) ??
          DEFAULT_LOCAL_PORT)
    return {
      enabled: parsed.enabled === true,
      localPort,
      defaultAction: parsed.defaultAction === 'bypass' ? 'bypass' : 'proxy',
      fallbackToRemote: parsed.fallbackToRemote !== false,
      rules: storedRules
    }
  } catch {
    return defaults
  }
}

const proxyDraft = reactive<BrowserResourceProxyConfig>(loadProxyConfig())
const proxyApplied = ref(proxyDraft.enabled)

function proxyConfigSnapshot(): BrowserResourceProxyConfig {
  return {
    ...proxyDraft,
    rules: proxyDraft.rules.map((rule) => ({ ...rule }))
  }
}

function getWebview(): HTMLElement & {
  getWebContentsId(): number
  goBack(): void
  goForward(): void
  reload(): void
  loadURL(url: string): Promise<void>
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return webviewRef.value as any
}

function goBack(): void {
  const wv = getWebview()
  if (wv) wv.goBack()
}

function goForward(): void {
  const wv = getWebview()
  if (wv) wv.goForward()
}

async function reload(): Promise<void> {
  const wv = getWebview()
  if (!wv) return

  try {
    await window.api.browserSetResourceProxyOrigin(props.paneId, wv.getURL())
    wv.reload()
  } catch (error) {
    proxyError.value = error instanceof Error ? error.message : String(error)
  }
}

function toggleProxyPanel(): void {
  proxyPanelOpen.value = !proxyPanelOpen.value
}

function addProxyRule(): void {
  const action = proxyDraft.defaultAction === 'proxy' ? 'bypass' : 'proxy'
  proxyDraft.rules.push(createProxyRule('', action))
}

function removeProxyRule(index: number): void {
  proxyDraft.rules.splice(index, 1)
}

async function applyProxyConfig(): Promise<void> {
  if (proxySaving.value) return
  proxySaving.value = true
  proxyError.value = ''
  try {
    const applied = await window.api.browserSetResourceProxy(props.paneId, proxyConfigSnapshot())
    Object.assign(proxyDraft, applied)
    proxyApplied.value = applied.enabled
    localStorage.setItem(proxyStorageKey, JSON.stringify(applied))
    localStorage.removeItem(legacyProxyStorageKey)
    await reload()
  } catch (error) {
    proxyError.value = error instanceof Error ? error.message : String(error)
  } finally {
    proxySaving.value = false
  }
}

async function navigateToUrl(): Promise<void> {
  const input = urlInputRef.value?.value
  if (input) {
    const wv = getWebview()
    if (!wv) return

    try {
      await window.api.browserSetResourceProxyOrigin(props.paneId, input)
      await wv.loadURL(input)
    } catch (error) {
      if (!String(error).includes('ERR_ABORTED')) {
        console.error('[BrowserDrawer] 导航失败:', error)
      }
    }
  }
}

function updateNavState(): void {
  const wv = getWebview()
  if (!wv) return
  try {
    currentUrl.value = wv.getURL() || currentUrl.value
    canGoBack.value = wv.canGoBack()
    canGoForward.value = wv.canGoForward()
  } catch {
    // webview 可能尚未就绪
  }
}

onMounted(() => {
  const wv = getWebview()
  if (!wv) return

  void window.api
    .browserSetResourceProxy(props.paneId, proxyConfigSnapshot())
    .then((applied) => {
      Object.assign(proxyDraft, applied)
      proxyApplied.value = applied.enabled
    })
    .catch((error) => {
      proxyApplied.value = false
      proxyError.value = error instanceof Error ? error.message : String(error)
    })

  // 等待 webview 加载完成后注册到 main process
  const onDomReady = (): void => {
    try {
      const wcId = (
        webviewRef.value as unknown as { getWebContentsId(): number }
      ).getWebContentsId()
      window.api.browserRegister(props.paneId, wcId)
    } catch (e) {
      console.error('[BrowserDrawer] 注册 webview 失败:', e)
    }
  }

  const onNavigated = (): void => {
    updateNavState()
  }

  wv.addEventListener('dom-ready', onDomReady)
  wv.addEventListener('did-navigate', onNavigated)
  wv.addEventListener('did-navigate-in-page', onNavigated)
  wv.addEventListener('did-start-loading', updateNavState)
  wv.addEventListener('did-stop-loading', updateNavState)

  // 挂载去抖动：webview 可能还需要一点时间才能 call getWebContentsId
  // dom-ready 事件一般在首帧渲染后触，届时 devtools 可用
  emit('ready')
})

onUnmounted(() => {
  window.api.browserUnregister(props.paneId)
})
</script>

<style scoped lang="scss" src="@renderer/assets/style/components/BrowserDrawer.scss"></style>
