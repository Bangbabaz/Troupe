// CDP 原子操作封装。
//
// 将 mcp-server.ts 中分散的 CDP 调用抽出为职责单一的函数，
// 供 mcp-server 和 browser-actions 共同使用。

import { executeCdp, waitForCdpEvent } from './browser'
import { ACTIONABILITY_SCRIPT } from './browser-injected'

// ---------------------------------------------------------------------------
// 导航
// ---------------------------------------------------------------------------

export async function navigate(
  paneId: string,
  url: string
): Promise<{ title: string; url: string }> {
  // 设虚拟视口 1280×720，页面按桌面端渲染，不受抽屉实际宽度影响
  await executeCdp(paneId, 'Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false
  })

  await executeCdp(paneId, 'Page.enable')
  await executeCdp(paneId, 'Page.setLifecycleEventsEnabled', { enabled: true })
  const loadController = new AbortController()
  let resolveLoaderId!: (loaderId: string | undefined) => void
  const loaderId = new Promise<string | undefined>((resolve) => {
    resolveLoaderId = resolve
  })
  const loadEvent = waitForCdpEvent(
    paneId,
    'Page.lifecycleEvent',
    async (params) => {
      const expectedLoaderId = await loaderId
      const event = params as { loaderId?: string; name?: string }
      return !!expectedLoaderId && event.loaderId === expectedLoaderId && event.name === 'load'
    },
    10_000,
    loadController.signal
  )
  let navResult: { frameId?: string; loaderId?: string; errorText?: string }
  try {
    navResult = (await executeCdp(paneId, 'Page.navigate', { url })) as typeof navResult
  } catch (error) {
    resolveLoaderId(undefined)
    loadController.abort()
    await loadEvent
    throw error
  }
  resolveLoaderId(navResult.loaderId)

  if (navResult?.errorText) {
    loadController.abort()
    await loadEvent
    throw new Error(`导航失败: ${navResult.errorText}`)
  }

  if (navResult.loaderId) await loadEvent
  else {
    loadController.abort()
    await loadEvent
  }

  const title = await getPageTitle(paneId)
  return { title, url }
}

// ---------------------------------------------------------------------------
// 截图
// ---------------------------------------------------------------------------

export async function screenshot(
  paneId: string,
  clip?: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const params: Record<string, unknown> = { format: 'png' }
  if (clip) {
    params.clip = { ...clip, scale: 1 }
  }

  const result = (await executeCdp(paneId, 'Page.captureScreenshot', params)) as { data: string }
  return result.data
}

export async function setViewport(
  paneId: string,
  width: number,
  height: number,
  deviceScaleFactor: number = 1,
  mobile: boolean = false
): Promise<{ width: number; height: number; deviceScaleFactor: number; mobile: boolean }> {
  await executeCdp(paneId, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor,
    mobile
  })
  return { width, height, deviceScaleFactor, mobile }
}

export async function clearViewport(paneId: string): Promise<void> {
  await executeCdp(paneId, 'Emulation.clearDeviceMetricsOverride')
}

export async function getPageState(paneId: string): Promise<Record<string, unknown>> {
  return evaluate<Record<string, unknown>>(
    paneId,
    `(() => ({
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      },
      focused: document.activeElement ? {
        tag: document.activeElement.tagName.toLowerCase(),
        id: document.activeElement.id || undefined,
        className: typeof document.activeElement.className === 'string' ? document.activeElement.className : undefined,
        text: (document.activeElement.textContent || '').trim().slice(0, 120)
      } : null
    }))()`
  )
}

export async function getWebStorage(
  paneId: string,
  storage: 'local' | 'session',
  key?: string
): Promise<Record<string, string | null>> {
  const store = storage === 'local' ? 'localStorage' : 'sessionStorage'
  return evaluate<Record<string, string | null>>(
    paneId,
    `(() => {
      const s = window.${store};
      const key = ${JSON.stringify(key ?? null)};
      if (key !== null) return { [key]: s.getItem(key) };
      const out = {};
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        out[k] = s.getItem(k);
      }
      return out;
    })()`
  )
}

export async function setWebStorage(
  paneId: string,
  storage: 'local' | 'session',
  key: string,
  value: string
): Promise<void> {
  const store = storage === 'local' ? 'localStorage' : 'sessionStorage'
  await evaluate(
    paneId,
    `window.${store}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`
  )
}

export async function removeWebStorage(
  paneId: string,
  storage: 'local' | 'session',
  key?: string
): Promise<void> {
  const store = storage === 'local' ? 'localStorage' : 'sessionStorage'
  const script = key
    ? `window.${store}.removeItem(${JSON.stringify(key)})`
    : `window.${store}.clear()`
  await evaluate(paneId, script)
}

// ---------------------------------------------------------------------------
// 鼠标点击（接收坐标，含 actionability check）
// ---------------------------------------------------------------------------

export async function click(paneId: string, x: number, y: number): Promise<void> {
  await executeCdp(paneId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y
  })
  await executeCdp(paneId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await executeCdp(paneId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
}

// ---------------------------------------------------------------------------
// 鼠标悬停
// ---------------------------------------------------------------------------

export async function hover(paneId: string, x: number, y: number): Promise<void> {
  await executeCdp(paneId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y
  })
}

// ---------------------------------------------------------------------------
// CSS 选择器 → 元素几何信息
// ---------------------------------------------------------------------------

export async function querySelectorBox(
  paneId: string,
  selector: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const nodeResult = (await executeCdp(paneId, 'DOM.getDocument', {
      depth: -1
    })) as { root: { nodeId: number } }

    const queryResult = (await executeCdp(paneId, 'DOM.querySelector', {
      nodeId: nodeResult.root.nodeId,
      selector
    })) as { nodeId: number }

    if (!queryResult.nodeId || queryResult.nodeId === 0) {
      return null
    }

    const boxResult = (await executeCdp(paneId, 'DOM.getBoxModel', {
      nodeId: queryResult.nodeId
    })) as { model: { content: number[] } }

    if (!boxResult?.model?.content || boxResult.model.content.length < 8) {
      return null
    }

    const [x1, y1, x2, y2, x3, y3, x4, y4] = boxResult.model.content
    const x = Math.min(x1, x2, x3, x4)
    const y = Math.min(y1, y2, y3, y4)
    const w = Math.max(x1, x2, x3, x4) - x
    const h = Math.max(y1, y2, y3, y4) - y

    return { x: x + w / 2, y: y + h / 2, width: w, height: h }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 执行注入脚本并返回结果
// ---------------------------------------------------------------------------

export async function evaluate<T>(paneId: string, expression: string): Promise<T> {
  const result = (await executeCdp(paneId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })) as {
    result: { type: string; value?: T; description?: string }
    exceptionDetails?: {
      text?: string
      exception?: { description?: string }
    }
  }

  if (result?.exceptionDetails) {
    const msg =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Unknown'
    throw new Error(`执行脚本出错: ${msg}`)
  }

  return result?.result?.value as T
}

// ---------------------------------------------------------------------------
// element resolve: 查询元素位置 + actionability check
// ---------------------------------------------------------------------------

export async function resolveElement(
  paneId: string,
  selector: string
): Promise<
  | { actionable: true; x: number; y: number; width: number; height: number }
  | { actionable: false; reason: string; selector: string; suggestion?: string }
> {
  // 先跑 actionability check
  const check = await evaluate<{
    actionable: boolean
    reason?: string
    center?: { x: number; y: number }
    rect?: { x: number; y: number; width: number; height: number }
    selector: string
    coveredBy?: { tag: string; className: string }
  }>(paneId, `${ACTIONABILITY_SCRIPT}(${JSON.stringify(selector)})`)

  if (!check.actionable) {
    let suggestion: string | undefined
    switch (check.reason) {
      case 'element_is_outside_viewport':
        suggestion = '尝试用 browser_scroll 滚动到该元素，或使用 browser_snapshot 找可见的替代元素'
        break
      case 'element_is_covered_by':
        suggestion = `元素被 ${check.coveredBy?.tag || '其他元素'} 遮挡，可能需要先关闭弹窗/模态框，或滚动页面`
        break
      case 'element_is_disabled':
        suggestion = '该元素当前为 disabled 状态，可能需要先完成其他操作'
        break
    }
    return { actionable: false, reason: check.reason!, selector, suggestion }
  }

  return {
    actionable: true,
    x: check.center!.x,
    y: check.center!.y,
    width: check.rect!.width,
    height: check.rect!.height
  }
}

// ---------------------------------------------------------------------------
// 等待条件满足
// ---------------------------------------------------------------------------

export async function waitFor(
  paneId: string,
  script: string,
  timeout: number
): Promise<{ success: boolean; elapsed: number; reason?: string }> {
  const start = Date.now()
  const interval = 100

  while (Date.now() - start < timeout) {
    const result = await evaluate<boolean>(paneId, script)
    if (result) {
      return { success: true, elapsed: Date.now() - start }
    }
    await sleep(interval)
  }

  return { success: false, elapsed: timeout, reason: 'timeout' }
}

// ---------------------------------------------------------------------------
// 键盘事件
// ---------------------------------------------------------------------------

interface KeyDef {
  keyCode: number
  code: string
  key: string
  /** windowsVirtualKeyCode，仅在 keyDown/keyUp 时用到 */
  windowsVirtualKeyCode: number
}

const KEY_MAP: Record<string, KeyDef> = {
  Enter: { keyCode: 13, code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { keyCode: 9, code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { keyCode: 27, code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { keyCode: 8, code: 'Backspace', key: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { keyCode: 40, code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { keyCode: 38, code: 'ArrowUp', key: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { keyCode: 39, code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Space: { keyCode: 32, code: 'Space', key: ' ', windowsVirtualKeyCode: 32 },
  Home: { keyCode: 36, code: 'Home', key: 'Home', windowsVirtualKeyCode: 36 },
  End: { keyCode: 35, code: 'End', key: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { keyCode: 33, code: 'PageUp', key: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { keyCode: 34, code: 'PageDown', key: 'PageDown', windowsVirtualKeyCode: 34 },
  Delete: { keyCode: 46, code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46 },
  Insert: { keyCode: 45, code: 'Insert', key: 'Insert', windowsVirtualKeyCode: 45 },
  F1: { keyCode: 112, code: 'F1', key: 'F1', windowsVirtualKeyCode: 112 },
  F2: { keyCode: 113, code: 'F2', key: 'F2', windowsVirtualKeyCode: 113 },
  F3: { keyCode: 114, code: 'F3', key: 'F3', windowsVirtualKeyCode: 114 },
  F4: { keyCode: 115, code: 'F4', key: 'F4', windowsVirtualKeyCode: 115 },
  F5: { keyCode: 116, code: 'F5', key: 'F5', windowsVirtualKeyCode: 116 },
  F6: { keyCode: 117, code: 'F6', key: 'F6', windowsVirtualKeyCode: 117 },
  F7: { keyCode: 118, code: 'F7', key: 'F7', windowsVirtualKeyCode: 118 },
  F8: { keyCode: 119, code: 'F8', key: 'F8', windowsVirtualKeyCode: 119 },
  F9: { keyCode: 120, code: 'F9', key: 'F9', windowsVirtualKeyCode: 120 },
  F10: { keyCode: 121, code: 'F10', key: 'F10', windowsVirtualKeyCode: 121 },
  F11: { keyCode: 122, code: 'F11', key: 'F11', windowsVirtualKeyCode: 122 },
  F12: { keyCode: 123, code: 'F12', key: 'F12', windowsVirtualKeyCode: 123 }
}

const MODIFIER_MAP: Record<string, number> = {
  Control: 2,
  Alt: 1,
  Shift: 8,
  Meta: 4
}

export async function keyPress(
  paneId: string,
  keyCombo: string,
  modifiers?: number
): Promise<void> {
  // 解析 modifier+主键，如 "Control+a" → modifiers=2, key="a"
  let key = keyCombo
  let mods = modifiers ?? 0

  for (const [name, mask] of Object.entries(MODIFIER_MAP)) {
    if (keyCombo.startsWith(name + '+')) {
      mods |= mask
      key = keyCombo.slice(name.length + 1)
    }
  }

  // 主键可能是单字符（a, b, c）或有名键（Enter, Tab 等）
  const def = KEY_MAP[key] ?? {
    keyCode: key.toUpperCase().charCodeAt(0),
    code: 'Key' + key.toUpperCase(),
    key: key,
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0)
  }

  const baseParams = {
    type: 'rawKeyDown' as const,
    ...def,
    modifiers: mods,
    unmodifiedText: def.key,
    text: def.key
  }

  // keyDown
  await executeCdp(paneId, 'Input.dispatchKeyEvent', baseParams)

  // char（仅对可打印字符）
  if (key.length === 1 && !mods) {
    await executeCdp(paneId, 'Input.dispatchKeyEvent', {
      type: 'char',
      text: key,
      key: key,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode
    })
  }

  // keyUp
  await executeCdp(paneId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...def,
    modifiers: mods
  })
}

// ---------------------------------------------------------------------------
// 页面标题
// ---------------------------------------------------------------------------

async function getPageTitle(paneId: string): Promise<string> {
  try {
    const result = (await executeCdp(paneId, 'Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true
    })) as { result: { value: string } }
    return result?.result?.value ?? ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
