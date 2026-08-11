// 高层复合动作。
//
// 将多个 CDP 原子操作组合成语义化动作（fill、select、check 等），
// 供 MCP server 的工具 handler 直接调用。

import * as driver from './browser-driver'
import {
  FILL_SCRIPT,
  ACTIONABILITY_SCRIPT,
  SCROLL_INTO_VIEW_SCRIPT,
  SELECT_OPTION_SCRIPT,
  CHECK_SCRIPT
} from './browser-injected'
import { executeCdp } from './browser'

// ---------------------------------------------------------------------------
// fill — 填入文本（兼容 React/Vue 受控组件）
// ---------------------------------------------------------------------------

export async function fill(
  paneId: string,
  selector: string,
  value: string
): Promise<{ success: boolean; error?: string; value?: string; fallbackUsed?: boolean }> {
  // 1. actionability check
  const check = await driver.evaluate<{
    actionable: boolean
    reason?: string
    center?: { x: number; y: number }
  }>(paneId, `${ACTIONABILITY_SCRIPT}(${JSON.stringify(selector)})`)

  if (!check.actionable) {
    // 如果在视口外 → 自动滚动
    if (check.reason === 'element_is_outside_viewport') {
      await driver.evaluate(paneId, `${SCROLL_INTO_VIEW_SCRIPT}(${JSON.stringify(selector)})`)
      // 等待滚动完成
      await sleep(200)
    } else if (check.reason === 'element_is_disabled') {
      return { success: false, error: `元素 ${selector} 处于 disabled 状态` }
    } else if (check.reason?.startsWith('element_is_covered_by')) {
      return { success: false, error: check.reason }
    }
  }

  // 2. 点击聚焦
  const box = await driver.querySelectorBox(paneId, selector)
  if (box) {
    await driver.click(paneId, box.x, box.y)
    await sleep(100)
  }

  // 3. 执行注入 fill 脚本
  const result = await driver.evaluate<{
    success: boolean
    error?: string
    value?: string
  }>(paneId, `${FILL_SCRIPT}(${JSON.stringify(selector)}, ${JSON.stringify(value)})`)

  if (result.success) {
    return { success: true, value: result.value }
  }

  // 4. fallback: 剪贴板方案
  // 先全选删除
  await driver.evaluate(
    paneId,
    `(() => { const el = document.querySelector('${selector.replace(/'/g, "\\'")}'); if (el) { el.focus(); try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch(_) {} } })()`
  )

  // 通过 CDP 逐字符键入（使用 Input.insertText —— 速度快于逐字符 dispatchKeyEvent）
  await executeCdp(paneId, 'Input.insertText', { text: value })

  // 触发事件
  await driver.evaluate(
    paneId,
    `(() => { const el = document.querySelector('${selector.replace(/'/g, "\\'")}'); if (el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } })()`
  )

  // 验证
  const actual = await driver.evaluate<string>(
    paneId,
    `document.querySelector('${selector.replace(/'/g, "\\'")}')?.value ?? ''`
  )

  return {
    success: actual === value,
    value: actual,
    fallbackUsed: true
  }
}

// ---------------------------------------------------------------------------
// type — 逐字符真实键入（保留给搜索自动补全等场景）
// ---------------------------------------------------------------------------

export async function type(
  paneId: string,
  selector: string,
  text: string
): Promise<{ success: boolean }> {
  const box = await driver.querySelectorBox(paneId, selector)
  if (!box) return { success: false }

  // 点击聚焦
  await driver.click(paneId, box.x, box.y)
  await sleep(100)

  // 逐字符键入
  for (const char of text) {
    await executeCdp(paneId, 'Input.dispatchKeyEvent', {
      type: 'char',
      text: char,
      key: char,
      windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0)
    })
  }

  return { success: true }
}

// ---------------------------------------------------------------------------
// selectOption — 选择下拉选项
// ---------------------------------------------------------------------------

export async function selectOption(
  paneId: string,
  selector: string,
  value?: string,
  label?: string
): Promise<{ success: boolean; error?: string; selected?: string }> {
  // 先试原生 select
  const nativeResult = await driver.evaluate<{
    success: boolean
    error?: string
    value?: string
    text?: string
  }>(
    paneId,
    `${SELECT_OPTION_SCRIPT}(${JSON.stringify(selector)}, ${JSON.stringify(value ?? null)}, ${JSON.stringify(label ?? null)})`
  )

  if (nativeResult.success) {
    return { success: true, selected: nativeResult.text ?? nativeResult.value }
  }

  if (nativeResult.error === 'not_a_select_element') {
    // 自定义下拉（antd / element-ui 等）
    // 1. 点击 selector 打开下拉
    const box = await driver.querySelectorBox(paneId, selector)
    if (!box) return { success: false, error: `未找到元素: ${selector}` }

    await driver.click(paneId, box.x, box.y)

    // 2. 等待下拉出现
    await sleep(300)

    // 3. 查找匹配的 option
    const searchText = label || value || ''
    const optionResult = await driver.evaluate<{
      found: boolean
      selector?: string
      error?: string
    }>(
      paneId,
      `(function() {
        var search = ${JSON.stringify(searchText)};
        // 遍历常见的下拉选项选择器
        var candidates = document.querySelectorAll(
          '[role="option"], [role="listitem"], .el-select-dropdown__item, ' +
          '.ant-select-item, .rc-virtual-list-holder-inner > div, ' +
          'li[role="option"], .vs__dropdown-option, .multiselect__option'
        );
        for (var i = 0; i < candidates.length; i++) {
          var c = candidates[i];
          var t = (c.textContent || '').trim();
          if (t === search || t.includes(search)) {
            // 生成临时唯一标识
            if (!c.id) c.id = '__troupe_tmp_' + i;
            return { found: true, selector: '#' + c.id };
          }
        }
        return { found: false, error: search ? '未找到匹配 "' + search + '" 的下拉选项' : '未找到下拉选项' };
      })()`
    )

    if (!optionResult.found) {
      return { success: false, error: optionResult.error }
    }

    // 4. 点击 option
    const optBox = await driver.querySelectorBox(paneId, optionResult.selector!)
    if (optBox) {
      await driver.click(paneId, optBox.x, optBox.y)
      return { success: true, selected: searchText }
    }

    return { success: false, error: '无法获取选项位置' }
  }

  return { success: false, error: nativeResult.error }
}

// ---------------------------------------------------------------------------
// check — 勾选/取消勾选
// ---------------------------------------------------------------------------

export async function check(
  paneId: string,
  selector: string,
  checked: boolean = true
): Promise<{ success: boolean; error?: string; checked?: boolean }> {
  const result = await driver.evaluate<{
    success: boolean
    error?: string
    checked?: boolean
    tag?: string
  }>(paneId, `${CHECK_SCRIPT}(${JSON.stringify(selector)}, ${checked})`)

  if (result.success) {
    return { success: true, checked: result.checked }
  }

  return { success: false, error: result.error }
}

// ---------------------------------------------------------------------------
// upload — 文件上传
// ---------------------------------------------------------------------------

export async function upload(
  paneId: string,
  selector: string,
  filePaths: string[]
): Promise<{ success: boolean; error?: string }> {
  try {
    // 获取文档根节点
    const nodeResult = (await executeCdp(paneId, 'DOM.getDocument', {
      depth: -1
    })) as { root: { nodeId: number } }

    // 查询目标元素
    const queryResult = (await executeCdp(paneId, 'DOM.querySelector', {
      nodeId: nodeResult.root.nodeId,
      selector
    })) as { nodeId: number }

    if (!queryResult.nodeId || queryResult.nodeId === 0) {
      return { success: false, error: `未找到元素: ${selector}` }
    }

    // 设置文件
    await executeCdp(paneId, 'DOM.setFileInputFiles', {
      nodeId: queryResult.nodeId,
      files: filePaths
    })

    // 触发 change 事件
    await driver.evaluate(
      paneId,
      `(function() {
        var el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`
    )

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// waitAndClick — 等待元素出现+可操作 → 点击
// ---------------------------------------------------------------------------

export async function waitAndClick(
  paneId: string,
  selector: string,
  timeout: number = 5000
): Promise<{ success: boolean; error?: string }> {
  // 等待元素 attached
  const waitResult = await driver.waitFor(
    paneId,
    `(function() { return document.querySelector('${selector.replace(/'/g, "\\'")}') !== null; })()`,
    timeout
  )

  if (!waitResult.success) {
    return { success: false, error: `等待超时 (${timeout}ms): 元素 ${selector} 未出现` }
  }

  // 等一小段让动画完成
  await sleep(200)

  // 获取元素位置并点击
  const box = await driver.querySelectorBox(paneId, selector)
  if (!box) {
    return { success: false, error: `元素存在但无法获取位置: ${selector}` }
  }

  await driver.click(paneId, box.x, box.y)
  return { success: true }
}

// ---------------------------------------------------------------------------
// formFill — 批量 fill
// ---------------------------------------------------------------------------

export async function formFill(
  paneId: string,
  fields: Record<string, string>
): Promise<{ results: Record<string, boolean> }> {
  const results: Record<string, boolean> = {}

  for (const [selector, value] of Object.entries(fields)) {
    const r = await fill(paneId, selector, value)
    results[selector] = r.success
  }

  return { results }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
