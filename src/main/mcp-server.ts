// MCP (Model Context Protocol) HTTP Server —— legacy SSE + Streamable HTTP transports。
//
// 监听 127.0.0.1 上的可配置端口，提供终端控制与浏览器自动化工具。
// Agent 通过 shell 环境变量 TROUPE_PANE_ID 获取自己的 paneId，
// 在每个工具调用中作为 paneId 参数传入，server 据此路由到对应浏览器。
// 不传 paneId 且仅有一个活跃浏览器时自动匹配（多浏览器时报错提示）。
//
// MCP over legacy SSE 协议:
//   1. Client → GET /sse → 服务器返回 SSE 流（无需 ?pane=）
//   2. Server 先发 `event: endpoint` 告知消息端点 URL
//   3. Client → POST /message?sessionId=<id> → JSON-RPC 请求
//   4. Server 通过 SSE 流返回 JSON-RPC response
//
// MCP over Streamable HTTP 协议:
//   1. Client → POST /mcp (initialize) → JSON-RPC response + Mcp-Session-Id
//   2. 后续 POST /mcp 携带 Mcp-Session-Id → JSON-RPC response
//   3. Client → DELETE /mcp 携带 Mcp-Session-Id → 关闭会话

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { URL } from 'url'
import { clipboard } from 'electron'
import {
  addRouteRule,
  clearDownloads,
  executeCdp,
  hasBrowser,
  waitForActivation,
  getActiveBrowserPaneIds,
  getNetworkRequests,
  getNetworkResponseBody,
  getPendingDialog,
  clearPendingDialog,
  getConsoleLogs,
  clearConsoleLogs,
  clearRouteRules,
  getDownloads,
  getRouteRules,
  type BrowserRouteRule
} from './browser'
import type { NetworkEntry } from './browser'
import * as driver from './browser-driver'
import * as actions from './browser-actions'
import { getAccessibilitySnapshot, formatSnapshot, getQuickSnapshot } from './browser-snapshot'
import { waitScript, ELEMENT_INFO_SCRIPT } from './browser-injected'
import { getPtyWebContents } from './shell'
import {
  AGENT_TOOLS,
  clearAgentState,
  handleAgentToolCall,
  isAgentTool,
  type AgentToolHost,
  type AgentSessionState
} from './mcp-agent'
import { TERMINAL_TOOLS, handleTerminalToolCall, isTerminalTool } from './mcp-terminal'
import {
  AGENT_MCP_PORT,
  BROWSER_MCP_PORT,
  MCP_ACCESS_TOKEN,
  MCP_HOST,
  TERMINAL_MCP_PORT
} from './mcp-config'
import {
  isJsonContentType,
  isMcpRequestAuthorized,
  isMcpRequestOriginAllowed
} from './mcp-http-security'
import type { McpToolDef, McpToolResult } from './mcp-types'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** JSON-RPC 错误码 */
const ERR_PARSE = -32700
const ERR_REQUEST = -32600
const ERR_METHOD = -32601
const ERR_INVALID = -32602
const ERR_INTERNAL = -32603

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25'
])
const DEFAULT_PROTOCOL_VERSION = '2025-11-25'
const MAX_REQUEST_BODY_BYTES = 1024 * 1024
const MAX_HTTP_SESSIONS = 128
const MAX_SSE_SESSIONS = 64
const HTTP_SESSION_IDLE_TTL_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface McpSession {
  id: string
  kind: McpServerKind
  transport: 'sse' | 'http'
  paneId?: string
  accessToken?: string
  agent?: AgentSessionState
  protocolVersion?: string
  lastActivityAt: number
}

interface SseSession extends McpSession {
  transport: 'sse'
  res: ServerResponse
}

type McpServerKind = 'browser' | 'agent' | 'terminal'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

// ---------------------------------------------------------------------------
// paneId 参数 schema（注入到每个工具的 inputSchema）
// ---------------------------------------------------------------------------

const PANE_ID_SCHEMA = {
  paneId: {
    type: 'string',
    description:
      '当前终端面板的 ID。从环境变量 TROUPE_PANE_ID 读取。' +
      '仅有一个活跃浏览器时可省略（自动匹配）；多个浏览器时必填。'
  }
} as const

// ---------------------------------------------------------------------------
// MCP 工具定义
// ---------------------------------------------------------------------------

const BROWSER_TOOLS: McpToolDef[] = [
  // ---- 原子工具 ----
  {
    // #1
    name: 'browser_navigate',
    description:
      '导航到指定 URL，返回页面 title、最终 URL 和前 10 个可交互元素快照。' +
      '示例：{url: "https://example.com"}。' +
      '导航后直接得到页面结构概览，无需额外调用 snapshot。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '目标 URL，需带协议头（如 https://example.com）'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['url']
    }
  },
  {
    // #2
    name: 'browser_screenshot',
    description:
      '截取当前页面或指定元素的截图，返回 base64 编码的 PNG 图片。' +
      '示例：{selector: "#main"} 截取元素；不传 selector 截整个视口。' +
      '截图消耗较多 token，优先用 browser_snapshot 了解页面状态。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器。不传则截整个视口；传入则截该元素的 bounding box'
        },
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    // #3
    name: 'browser_click',
    description:
      '点击页面元素（CSS 选择器）或指定坐标。含 actionability check——' +
      '自动检测可见性、遮挡、disabled、是否在视口内。' +
      '示例：{selector: "#submit-btn"} 或 {x: 100, y: 200}。' +
      '元素被遮挡或不可操作时返回具体原因和建议。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器，与 x/y 二选一'
        },
        x: { type: 'number', description: 'X 坐标（与 y 一起使用）' },
        y: { type: 'number', description: 'Y 坐标（与 x 一起使用）' },
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    // #4
    name: 'browser_type',
    description:
      '逐字符模拟真实键入（触发 keydown/keypress/keyup 事件）。' +
      '适合搜索框自动补全、密码强度检测等依赖逐字符事件的场景。' +
      '示例：{selector: "#search", text: "hello"}。' +
      '普通表单填入文本请用 browser_fill（兼容 React/Vue 受控组件）。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '目标 input/textarea 的 CSS 选择器'
        },
        text: { type: 'string', description: '要输入的文本' },
        ...PANE_ID_SCHEMA
      },
      required: ['selector', 'text']
    }
  },
  {
    // #5
    name: 'browser_evaluate',
    description:
      '在页面中执行 JavaScript 表达式并返回结果（JSON 序列化）。' +
      '示例：{script: "document.title"} → 返回页面标题。' +
      '支持 async/await。',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '要执行的 JavaScript 代码' },
        ...PANE_ID_SCHEMA
      },
      required: ['script']
    }
  },
  {
    // #6
    name: 'browser_network',
    description:
      '获取网络请求信息。action=list 返回最近请求列表；action=get 获取指定请求的响应体。' +
      '示例：{action: "list"} 或 {action: "get", requestId: "1234.1"}。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get'],
          description: 'list=列请求列表, get=取单个请求响应体'
        },
        requestId: {
          type: 'string',
          description: 'action=get 时必填，要获取响应体的请求 ID'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['action']
    }
  },
  {
    // #7
    name: 'browser_snapshot',
    description:
      '获取页面语义化结构（可交互元素列表），比截图省 token。' +
      '返回每个元素的 ref（序号）、role、name、selector，以及 disabled/focused/checked 等状态。' +
      '最多 100 个节点。' +
      '优先用此工具了解页面状态，截图仅用于需要视觉判断的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    // #8
    name: 'browser_keyboard',
    description:
      '模拟键盘按键。支持单键（"Enter"、"Tab"、"Escape"、"ArrowDown"）和组合键（"Control+a"、"Meta+c"）。' +
      '示例：{key: "Enter"} 提交表单；{key: "Control+a"} 全选。' +
      '支持的功能键：Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, Space, Home, End, PageUp, PageDown, Delete, F1-F12',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: '按键名，如 "Enter"、"Tab"、"Escape"、"ArrowDown"、"Control+a"、"Meta+c"'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['key']
    }
  },
  {
    // #9
    name: 'browser_scroll',
    description:
      '滚动页面或指定元素。传 selector 则将该元素滚入视图；传 direction 则按方向滚动。' +
      '示例：{selector: "#footer"} 滚动到页脚；{direction: "down", amount: 300} 向下滚动 300px。' +
      '返回滚动后的 scrollX/scrollY。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器，将该元素滚入视口中心。与 direction 二选一'
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: '滚动方向（页面级滚动）'
        },
        amount: {
          type: 'number',
          description: '滚动像素数，默认 300'
        },
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    // #10
    name: 'browser_hover',
    description:
      '鼠标悬停到元素或坐标上，触发 hover 效果（下拉菜单、tooltip 等）。' +
      '示例：{selector: ".menu-item"} 或 {x: 200, y: 150}。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器，与 x/y 二选一' },
        x: { type: 'number', description: 'X 坐标（与 y 一起使用）' },
        y: { type: 'number', description: 'Y 坐标（与 x 一起使用）' },
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    // #11
    name: 'browser_wait',
    description:
      '等待元素达到指定状态。state 可选：visible（可见）、hidden（隐藏）、attached（存在于 DOM）、detached（不存在于 DOM）。' +
      '示例：{selector: ".loading", state: "hidden", timeout: 10000} 等待加载指示器消失。' +
      '默认超时 5000ms。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '要等待的元素的 CSS 选择器' },
        state: {
          type: 'string',
          enum: ['visible', 'hidden', 'attached', 'detached'],
          description: '等待目标状态，默认 visible'
        },
        timeout: {
          type: 'number',
          description: '超时毫秒数，默认 5000'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector']
    }
  },
  {
    // #12
    name: 'browser_element_info',
    description:
      '获取元素的详细属性。默认返回所有属性（text, value, visible, enabled, checked, href, placeholder, boundingBox）。' +
      '示例：{selector: "#email", properties: ["value", "enabled"]}。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器' },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description:
            '要查询的属性列表，可选：text, value, visible, enabled, checked, href, placeholder。默认全部'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector']
    }
  },
  {
    // #13
    name: 'browser_dialog',
    description:
      '处理浏览器原生弹窗（alert/confirm/prompt）。' +
      '示例：{action: "accept"} 点确定；{action: "dismiss"} 点取消；' +
      '{action: "accept", promptText: "hello"} 处理 prompt 并填入文本。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['accept', 'dismiss'],
          description: 'accept=确定, dismiss=取消'
        },
        promptText: {
          type: 'string',
          description: 'action=accept 且弹窗为 prompt 时，填入的文本'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['action']
    }
  },
  {
    // #14
    name: 'browser_console',
    description:
      '获取浏览器控制台输出（最近 50 条 log/warn/error/info）。' +
      '示例：{clear: true} 获取并清空缓冲。' +
      '用于调试页面 JS 错误。',
    inputSchema: {
      type: 'object',
      properties: {
        clear: {
          type: 'boolean',
          description: '是否在获取后清空缓冲，默认 false'
        },
        ...PANE_ID_SCHEMA
      }
    }
  },

  // ---- 复合工具 ----
  {
    // #15
    name: 'browser_fill',
    description:
      '在输入框填入文本（兼容 React/Vue 受控组件）。' +
      '使用 native setter + 事件序列绕过框架劫持。' +
      '示例：{selector: "#email", text: "a@b.com"}。' +
      '对 contenteditable 或需要触发自动补全的场景，改用 browser_type。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '目标 input/textarea 的 CSS 选择器' },
        text: { type: 'string', description: '要填入的文本' },
        ...PANE_ID_SCHEMA
      },
      required: ['selector', 'text']
    }
  },
  {
    // #16
    name: 'browser_select_option',
    description:
      '选择下拉选项，同时支持原生 <select> 和自定义 dropdown（antd/element-ui 等）。' +
      '示例：{selector: "#country", value: "cn"} 按 value 匹配；' +
      '{selector: ".ant-select", label: "China"} 按显示文本匹配。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '下拉元素的 CSS 选择器' },
        value: {
          type: 'string',
          description: '选项的 value 值，与 label 二选一'
        },
        label: {
          type: 'string',
          description: '选项的显示文本，与 value 二选一'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector']
    }
  },
  {
    // #17
    name: 'browser_check',
    description:
      '勾选或取消勾选 checkbox/radio。' +
      '示例：{selector: "#agree", checked: true} 勾选；{selector: "#agree", checked: false} 取消勾选。' +
      'checked 默认 true。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'checkbox/radio 的 CSS 选择器' },
        checked: {
          type: 'boolean',
          description: '目标勾选状态，默认 true'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector']
    }
  },
  {
    // #18
    name: 'browser_wait_and_click',
    description:
      '等待元素出现+可操作后自动点击。' +
      '示例：{selector: ".dialog-submit", timeout: 8000} 等待弹窗的提交按钮出现后点击。' +
      '如需手动分步控制，用 browser_wait + browser_click。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '要等待并点击的元素的 CSS 选择器' },
        timeout: {
          type: 'number',
          description: '超时毫秒数，默认 5000'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector']
    }
  },
  {
    // #19
    name: 'browser_form_fill',
    description:
      '批量填入表单。' +
      '示例：{fields: {"input[name=username]": "admin", "#email": "a@b.com"}}。' +
      'fields 的 key 是 CSS 选择器，value 是填入文本。各字段独立执行，部分失败不影响其余。',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          description: '选择器→文本映射，如 {"input[name=username]": "admin"}'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['fields']
    }
  },
  {
    // #20
    name: 'browser_upload',
    description:
      '文件上传。通过 CDP DOM.setFileInputFiles 设文件后触发 change 事件。' +
      '示例：{selector: "input[type=file]", filePaths: ["/path/to/file.pdf"]}。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'file input 的 CSS 选择器' },
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: '本地文件绝对路径列表'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector', 'filePaths']
    }
  },
  {
    name: 'browser_viewport',
    description:
      'Set, clear, or read the emulated viewport. Example: {action:"set", width:390, height:844, mobile:true}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'clear'] },
        width: { type: 'number' },
        height: { type: 'number' },
        deviceScaleFactor: { type: 'number' },
        mobile: { type: 'boolean' },
        ...PANE_ID_SCHEMA
      },
      required: ['action']
    }
  },
  {
    name: 'browser_storage',
    description:
      'Read/write/clear localStorage, sessionStorage, or cookies. Use storage=local/session/cookies.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'remove', 'clear'] },
        storage: { type: 'string', enum: ['local', 'session', 'cookies'] },
        key: { type: 'string' },
        value: { type: 'string' },
        name: { type: 'string' },
        url: { type: 'string' },
        domain: { type: 'string' },
        path: { type: 'string' },
        ...PANE_ID_SCHEMA
      },
      required: ['action', 'storage']
    }
  },
  {
    name: 'browser_state',
    description:
      'Return current title, URL, readyState, viewport, focused element, dialog, route and download counts.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    name: 'browser_by_ref',
    description:
      'Act on a current browser_snapshot ref. Actions: click, fill, type, hover, info, select_option, check.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number' },
        action: {
          type: 'string',
          enum: ['click', 'fill', 'type', 'hover', 'info', 'select_option', 'check']
        },
        text: { type: 'string' },
        value: { type: 'string' },
        label: { type: 'string' },
        checked: { type: 'boolean' },
        properties: { type: 'array', items: { type: 'string' } },
        ...PANE_ID_SCHEMA
      },
      required: ['ref', 'action']
    }
  },
  {
    name: 'browser_console_wait',
    description:
      'Wait for a console log matching type and text/regex. Example: {type:"error", text:"failed", timeout:5000}.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        text: { type: 'string' },
        regex: { type: 'string' },
        timeout: { type: 'number' },
        clear: { type: 'boolean' },
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    name: 'browser_network_wait',
    description:
      'Wait for a network request matching url/method/status. Optionally include response body.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        regex: { type: 'string' },
        method: { type: 'string' },
        status: { type: 'number' },
        timeout: { type: 'number' },
        includeBody: { type: 'boolean' },
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    name: 'browser_route',
    description:
      'List, add, or clear request interception rules. Add supports action=mock/abort/continue and urlPattern substring or /regex/.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'clear'] },
        id: { type: 'string' },
        urlPattern: { type: 'string' },
        method: { type: 'string' },
        routeAction: { type: 'string', enum: ['continue', 'abort', 'mock'] },
        status: { type: 'number' },
        headers: { type: 'object' },
        body: { type: 'string' },
        contentType: { type: 'string' },
        ...PANE_ID_SCHEMA
      },
      required: ['action']
    }
  },
  {
    name: 'browser_downloads',
    description: 'List, clear, or wait for browser downloads captured by CDP download events.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'clear', 'wait'] },
        timeout: { type: 'number' },
        state: { type: 'string', enum: ['inProgress', 'completed', 'canceled'] },
        ...PANE_ID_SCHEMA
      },
      required: ['action']
    }
  },
  {
    name: 'browser_clipboard',
    description: 'Read, write, or clear system clipboard text.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write', 'clear'] },
        text: { type: 'string' },
        ...PANE_ID_SCHEMA
      },
      required: ['action']
    }
  },
  {
    name: 'browser_steps',
    description:
      'Run multiple browser actions in one MCP call. Each step has action plus normal action args; stops on first error unless continueOnError=true.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'object' }
        },
        continueOnError: { type: 'boolean' },
        ...PANE_ID_SCHEMA
      },
      required: ['steps']
    }
  }
]

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const sseSessions = new Map<string, SseSession>()
const httpSessions = new Map<string, McpSession>()
const serverInstances = new Map<McpServerKind, ReturnType<typeof createServer>>()
let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null

const agentToolHost: AgentToolHost = {
  getPtyWebContents
}

function getToolsForKind(kind: McpServerKind): McpToolDef[] {
  if (kind === 'browser') return BROWSER_TOOLS
  if (kind === 'agent') return AGENT_TOOLS
  return TERMINAL_TOOLS
}

function getActiveMcpSessions(): McpSession[] {
  return [...sseSessions.values(), ...httpSessions.values()]
}

// ---------------------------------------------------------------------------
// paneId 解析 —— 从工具参数中提取 paneId，必要时自动匹配
// ---------------------------------------------------------------------------

async function resolvePaneId(args: Record<string, unknown> | undefined): Promise<string> {
  if (args?.paneId && typeof args.paneId === 'string') {
    if (!hasBrowser(args.paneId)) {
      const wc = getPtyWebContents(args.paneId)
      if (!wc || wc.isDestroyed()) {
        throw new Error(`面板 ${args.paneId} 不存在或已销毁。`)
      }
      wc.send('browser-activate', args.paneId)
      await waitForActivation(args.paneId)
    }
    return args.paneId
  }

  const activeIds = getActiveBrowserPaneIds()
  if (activeIds.length === 1) {
    return activeIds[0]
  }
  if (activeIds.length > 1) {
    throw new Error(`检测到多个浏览器面板，请显式传入 paneId：${activeIds.join(', ')}`)
  }

  throw new Error(
    '未找到活跃的浏览器面板。' +
      '请在工具调用中传入 paneId 参数（从环境变量 TROUPE_PANE_ID 读取），' +
      '首次调用时会自动激活该面板的浏览器。'
  )
}

// ---------------------------------------------------------------------------
// Tool call 分发
// ---------------------------------------------------------------------------

function textJson(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function matchesText(value: string, text?: string, regex?: string): boolean {
  if (regex) {
    try {
      return new RegExp(regex).test(value)
    } catch {
      return false
    }
  }
  return text ? value.includes(text) : true
}

async function selectorFromRef(paneId: string, ref: number): Promise<string> {
  const snapshot = await getAccessibilitySnapshot(paneId, 100)
  const node = snapshot.nodes.find((n) => n.ref === ref)
  if (!node) throw new Error(`Snapshot ref not found: ${ref}`)
  return node.selector
}

const SCROLL_INTO_VIEW_INLINE = `(selector) => {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: 'element_not_found' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  return { success: true, scrollX: window.scrollX, scrollY: window.scrollY };
}`

async function performBrowserAction(
  paneId: string,
  action: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (typeof args.ref === 'number' && !args.selector) {
    args = { ...args, selector: await selectorFromRef(paneId, args.ref) }
  }

  switch (action) {
    case 'navigate': {
      const url = args.url as string
      if (!url) throw new Error('missing url')
      return driver.navigate(paneId, url)
    }
    case 'click': {
      if (args.selector) {
        const result = await driver.resolveElement(paneId, args.selector as string)
        if (!result.actionable) return { success: false, ...result }
        await driver.click(paneId, result.x, result.y)
        return { success: true, selector: args.selector, x: result.x, y: result.y }
      }
      if (typeof args.x === 'number' && typeof args.y === 'number') {
        await driver.click(paneId, args.x, args.y)
        return { success: true, x: args.x, y: args.y }
      }
      throw new Error('missing selector or x/y')
    }
    case 'fill': {
      const selector = args.selector as string
      const text = args.text as string
      if (!selector) throw new Error('missing selector')
      if (text == null) throw new Error('missing text')
      return actions.fill(paneId, selector, text)
    }
    case 'type': {
      const selector = args.selector as string
      const text = args.text as string
      if (!selector) throw new Error('missing selector')
      if (text == null) throw new Error('missing text')
      return actions.type(paneId, selector, text)
    }
    case 'hover': {
      if (args.selector) {
        const box = await driver.querySelectorBox(paneId, args.selector as string)
        if (!box) throw new Error(`element not found: ${args.selector}`)
        await driver.hover(paneId, box.x, box.y)
        return { success: true, selector: args.selector, x: box.x, y: box.y }
      }
      if (typeof args.x === 'number' && typeof args.y === 'number') {
        await driver.hover(paneId, args.x, args.y)
        return { success: true, x: args.x, y: args.y }
      }
      throw new Error('missing selector or x/y')
    }
    case 'wait': {
      const selector = args.selector as string
      if (!selector) throw new Error('missing selector')
      return driver.waitFor(
        paneId,
        waitScript(selector, (args.state as string) || 'visible'),
        (args.timeout as number) || 5000
      )
    }
    case 'keyboard': {
      const key = args.key as string
      if (!key) throw new Error('missing key')
      await driver.keyPress(paneId, key)
      return { success: true, key }
    }
    case 'scroll': {
      if (args.selector) {
        return driver.evaluate(
          paneId,
          `${SCROLL_INTO_VIEW_INLINE}(${JSON.stringify(args.selector)})`
        )
      }
      const direction = (args.direction as string) || 'down'
      const amount = (args.amount as number) || 300
      const deltas: Record<string, [number, number]> = {
        down: [0, amount],
        up: [0, -amount],
        right: [amount, 0],
        left: [-amount, 0]
      }
      const [dx, dy] = deltas[direction] || [0, amount]
      return driver.evaluate(
        paneId,
        `(function(){ window.scrollBy(${dx}, ${dy}); return { success: true, scrollX: window.scrollX, scrollY: window.scrollY }; })()`
      )
    }
    case 'info': {
      const selector = args.selector as string
      if (!selector) throw new Error('missing selector')
      return driver.evaluate<Record<string, unknown>>(
        paneId,
        `${ELEMENT_INFO_SCRIPT}(${JSON.stringify(selector)}, ${JSON.stringify(args.properties || [])})`
      )
    }
    case 'select_option': {
      const selector = args.selector as string
      if (!selector) throw new Error('missing selector')
      return actions.selectOption(paneId, selector, args.value as string, args.label as string)
    }
    case 'check': {
      const selector = args.selector as string
      if (!selector) throw new Error('missing selector')
      return actions.check(paneId, selector, args.checked !== false)
    }
    case 'evaluate': {
      const script = args.script as string
      if (!script) throw new Error('missing script')
      return { value: await driver.evaluate(paneId, script) }
    }
    default:
      throw new Error(`Unsupported browser action: ${action}`)
  }
}

async function handleToolCall(
  session: McpSession,
  name: string,
  args: Record<string, unknown> | undefined
): Promise<McpToolResult> {
  if (isAgentTool(name)) {
    return handleAgentToolCall(agentToolHost, session, getActiveMcpSessions(), name, args)
  }
  if (isTerminalTool(name)) {
    return handleTerminalToolCall(session, name, args)
  }

  const paneId = await resolvePaneId(args)

  switch (name) {
    // ---- 原子工具 ----

    case 'browser_navigate': {
      const url = args?.url as string
      if (!url) throw new Error('缺少 url 参数')

      const navResult = await driver.navigate(paneId, url)

      // 获取 quickSnapshot（前 10 个可交互元素）
      let quickSnapshot: unknown[] = []
      try {
        quickSnapshot = (await getQuickSnapshot(paneId, 10)) as unknown as unknown[]
      } catch {
        // 快速快照失败不影响导航
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              title: navResult.title,
              url: navResult.url,
              ok: true,
              quickSnapshot
            })
          }
        ]
      }
    }

    case 'browser_screenshot': {
      const selector = args?.selector as string | undefined

      let clip: { x: number; y: number; width: number; height: number } | undefined
      if (selector) {
        const box = await driver.querySelectorBox(paneId, selector)
        if (!box) throw new Error(`未找到元素: ${selector}`)
        clip = {
          x: box.x - box.width / 2,
          y: box.y - box.height / 2,
          width: box.width,
          height: box.height
        }
      }

      const data = await driver.screenshot(paneId, clip)
      return {
        content: [{ type: 'image', data, mimeType: 'image/png' }]
      }
    }

    case 'browser_click': {
      if (args?.selector) {
        const result = await driver.resolveElement(paneId, args.selector as string)

        if (!result.actionable) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  clicked: false,
                  reason: result.reason,
                  selector: args.selector,
                  suggestion: result.suggestion
                })
              }
            ]
          }
        }

        await driver.click(paneId, result.x, result.y)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                clicked: true,
                x: result.x,
                y: result.y,
                selector: args.selector
              })
            }
          ]
        }
      }

      if (typeof args?.x === 'number' && typeof args?.y === 'number') {
        await driver.click(paneId, args.x, args.y)
        return {
          content: [{ type: 'text', text: JSON.stringify({ clicked: true, x: args.x, y: args.y }) }]
        }
      }

      throw new Error('需要 selector 或 {x, y} 参数')
    }

    case 'browser_type': {
      const selector = args?.selector as string
      const text = args?.text as string
      if (!selector) throw new Error('缺少 selector 参数')
      if (text == null) throw new Error('缺少 text 参数')

      const result = await actions.type(paneId, selector, text)
      if (!result.success) {
        throw new Error(`未找到元素: ${selector}`)
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ typed: true, text, selector }) }]
      }
    }

    case 'browser_evaluate': {
      const script = args?.script as string
      if (!script) throw new Error('缺少 script 参数')

      const value = await driver.evaluate(paneId, script)
      return {
        content: [{ type: 'text', text: JSON.stringify({ value }) }]
      }
    }

    case 'browser_network': {
      const action = args?.action as string
      if (!action) throw new Error('缺少 action 参数')

      if (action === 'list') {
        const entries: NetworkEntry[] = getNetworkRequests(paneId)
        const summary = entries.map((e) => ({
          requestId: e.requestId,
          url: e.url,
          method: e.method,
          status: e.status,
          type: e.type,
          duration: e.duration,
          size: e.size
        }))
        return {
          content: [
            { type: 'text', text: JSON.stringify({ requests: summary, count: summary.length }) }
          ]
        }
      }

      if (action === 'get') {
        const requestId = args?.requestId as string
        if (!requestId) throw new Error('action=get 需要 requestId 参数')
        const body = await getNetworkResponseBody(paneId, requestId)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                requestId,
                body: body.body,
                base64Encoded: body.base64Encoded
              })
            }
          ]
        }
      }

      throw new Error(`未知 action: ${action}，支持 list 和 get`)
    }

    case 'browser_snapshot': {
      const snapshot = await getAccessibilitySnapshot(paneId, 100)
      const formatted = formatSnapshot(snapshot)
      return {
        content: [
          { type: 'text', text: JSON.stringify({ nodes: snapshot.nodes, total: snapshot.total }) },
          { type: 'text', text: formatted }
        ]
      }
    }

    case 'browser_keyboard': {
      const key = args?.key as string
      if (!key) throw new Error('缺少 key 参数')

      await driver.keyPress(paneId, key)
      return {
        content: [{ type: 'text', text: JSON.stringify({ pressed: key }) }]
      }
    }

    case 'browser_scroll': {
      if (args?.selector) {
        // 元素级滚动
        const result = await driver.evaluate<{
          success: boolean
          error?: string
          scrollX?: number
          scrollY?: number
        }>(
          paneId,
          `(function(){ var el = document.querySelector('${(args.selector as string).replace(/'/g, "\\'")}'); if (!el) return { success: false, error: 'element_not_found' }; el.scrollIntoView({ block: 'center', behavior: 'instant' }); return { success: true, scrollX: window.scrollX, scrollY: window.scrollY }; })()`
        )
        if (!result.success) throw new Error(result.error!)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                scrolled: true,
                selector: args.selector,
                scrollX: result.scrollX,
                scrollY: result.scrollY
              })
            }
          ]
        }
      }

      // 页面级滚动
      const direction = (args?.direction as string) || 'down'
      const amount = (args?.amount as number) || 300

      const deltas: Record<string, [number, number]> = {
        down: [0, amount],
        up: [0, -amount],
        right: [amount, 0],
        left: [-amount, 0]
      }
      const [dx, dy] = deltas[direction] || [0, amount]

      const pos = await driver.evaluate<{ scrollX: number; scrollY: number }>(
        paneId,
        `(function(){ window.scrollBy(${dx}, ${dy}); return { scrollX: window.scrollX, scrollY: window.scrollY }; })()`
      )
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              scrolled: true,
              direction,
              amount,
              scrollX: pos.scrollX,
              scrollY: pos.scrollY
            })
          }
        ]
      }
    }

    case 'browser_hover': {
      let x: number, y: number

      if (args?.selector) {
        const box = await driver.querySelectorBox(paneId, args.selector as string)
        if (!box) throw new Error(`未找到元素: ${args.selector}`)
        x = box.x
        y = box.y
      } else if (typeof args?.x === 'number' && typeof args?.y === 'number') {
        x = args.x
        y = args.y
      } else {
        throw new Error('需要 selector 或 {x, y} 参数')
      }

      await driver.hover(paneId, x, y)
      return {
        content: [{ type: 'text', text: JSON.stringify({ hovered: true, x, y }) }]
      }
    }

    case 'browser_wait': {
      const selector = args?.selector as string
      const state = (args?.state as string) || 'visible'
      const timeout = (args?.timeout as number) || 5000

      if (!selector) throw new Error('缺少 selector 参数')

      const script = waitScript(selector, state)
      const result = await driver.waitFor(paneId, script, timeout)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              elapsed: result.elapsed,
              reason: result.reason,
              selector,
              state
            })
          }
        ]
      }
    }

    case 'browser_element_info': {
      const selector = args?.selector as string
      const properties = (args?.properties as string[]) || []
      if (!selector) throw new Error('缺少 selector 参数')

      const info = await driver.evaluate<Record<string, unknown>>(
        paneId,
        `${ELEMENT_INFO_SCRIPT}(${JSON.stringify(selector)}, ${JSON.stringify(properties)})`
      )

      return {
        content: [{ type: 'text', text: JSON.stringify(info) }]
      }
    }

    case 'browser_dialog': {
      const action = args?.action as string

      const dialog = getPendingDialog(paneId)
      if (!dialog) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ hasDialog: false }) }]
        }
      }

      try {
        await executeCdp(paneId, 'Page.handleJavaScriptDialog', {
          accept: action === 'accept',
          promptText: args?.promptText as string | undefined
        })
      } catch {
        throw new Error('处理弹窗失败')
      }

      clearPendingDialog(paneId)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              handled: true,
              action,
              type: dialog.type,
              message: dialog.message
            })
          }
        ]
      }
    }

    case 'browser_console': {
      const clear = (args?.clear as boolean) || false
      const logs = getConsoleLogs(paneId)

      if (clear) {
        clearConsoleLogs(paneId)
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              logs,
              count: logs.length,
              cleared: clear
            })
          }
        ]
      }
    }

    // ---- 复合工具 ----

    case 'browser_fill': {
      const selector = args?.selector as string
      const text = args?.text as string
      if (!selector) throw new Error('缺少 selector 参数')
      if (text == null) throw new Error('缺少 text 参数')

      const result = await actions.fill(paneId, selector, text)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              error: result.error,
              value: result.value,
              text,
              selector,
              fallbackUsed: result.fallbackUsed
            })
          }
        ]
      }
    }

    case 'browser_select_option': {
      const selector = args?.selector as string
      const value = args?.value as string | undefined
      const label = args?.label as string | undefined

      if (!selector) throw new Error('缺少 selector 参数')
      if (!value && !label) throw new Error('需要 value 或 label 参数')

      const result = await actions.selectOption(paneId, selector, value, label)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              error: result.error,
              selected: result.selected
            })
          }
        ]
      }
    }

    case 'browser_check': {
      const selector = args?.selector as string
      const checked = args?.checked !== false // 默认 true

      if (!selector) throw new Error('缺少 selector 参数')

      const result = await actions.check(paneId, selector, checked)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              error: result.error,
              checked: result.checked
            })
          }
        ]
      }
    }

    case 'browser_wait_and_click': {
      const selector = args?.selector as string
      const timeout = (args?.timeout as number) || 5000

      if (!selector) throw new Error('缺少 selector 参数')

      const result = await actions.waitAndClick(paneId, selector, timeout)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              error: result.error
            })
          }
        ]
      }
    }

    case 'browser_form_fill': {
      const fields = args?.fields as Record<string, string>
      if (!fields || typeof fields !== 'object') throw new Error('缺少 fields 参数')

      const result = await actions.formFill(paneId, fields)
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }]
      }
    }

    case 'browser_upload': {
      const selector = args?.selector as string
      const filePaths = args?.filePaths as string[]
      if (!selector) throw new Error('缺少 selector 参数')
      if (!filePaths?.length) throw new Error('缺少 filePaths 参数')

      const result = await actions.upload(paneId, selector, filePaths)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              error: result.error
            })
          }
        ]
      }
    }

    case 'browser_viewport': {
      const action = args?.action as string
      if (action === 'get') return textJson(await driver.getPageState(paneId))
      if (action === 'clear') {
        await driver.clearViewport(paneId)
        return textJson({ success: true, action })
      }
      if (action === 'set') {
        const width = args?.width as number
        const height = args?.height as number
        if (!width || !height) throw new Error('browser_viewport set requires width and height')
        return textJson(
          await driver.setViewport(
            paneId,
            width,
            height,
            (args?.deviceScaleFactor as number) || 1,
            (args?.mobile as boolean) || false
          )
        )
      }
      throw new Error(`Unknown viewport action: ${action}`)
    }

    case 'browser_storage': {
      const action = args?.action as string
      const storage = args?.storage as 'local' | 'session' | 'cookies'
      if (!action || !storage) throw new Error('browser_storage requires action and storage')

      if (storage === 'cookies') {
        if (action === 'get') {
          const params = args?.url ? { urls: [String(args.url)] } : undefined
          return textJson(await executeCdp(paneId, 'Network.getCookies', params))
        }
        if (action === 'set') {
          const cookieName = (args?.name || args?.key) as string
          const value = args?.value as string
          if (!cookieName || value == null)
            throw new Error('cookie set requires name/key and value')
          return textJson(
            await executeCdp(paneId, 'Network.setCookie', {
              name: cookieName,
              value,
              url: args?.url,
              domain: args?.domain,
              path: args?.path
            })
          )
        }
        if (action === 'remove') {
          const cookieName = (args?.name || args?.key) as string
          if (!cookieName) throw new Error('cookie remove requires name/key')
          await executeCdp(paneId, 'Network.deleteCookies', {
            name: cookieName,
            url: args?.url,
            domain: args?.domain,
            path: args?.path
          })
          return textJson({ success: true, removed: cookieName })
        }
        if (action === 'clear') {
          await executeCdp(paneId, 'Network.clearBrowserCookies')
          return textJson({ success: true, cleared: 'cookies' })
        }
      } else {
        if (action === 'get') {
          return textJson(
            await driver.getWebStorage(paneId, storage, args?.key as string | undefined)
          )
        }
        if (action === 'set') {
          const key = args?.key as string
          const value = args?.value as string
          if (!key || value == null) throw new Error('storage set requires key and value')
          await driver.setWebStorage(paneId, storage, key, value)
          return textJson({ success: true, storage, key })
        }
        if (action === 'remove' || action === 'clear') {
          await driver.removeWebStorage(paneId, storage, args?.key as string | undefined)
          return textJson({ success: true, storage, key: args?.key, cleared: action === 'clear' })
        }
      }
      throw new Error(`Unknown storage action: ${action}`)
    }

    case 'browser_state': {
      return textJson({
        ...(await driver.getPageState(paneId)),
        dialog: getPendingDialog(paneId),
        consoleCount: getConsoleLogs(paneId).length,
        networkCount: getNetworkRequests(paneId).length,
        downloads: getDownloads(paneId),
        routes: getRouteRules(paneId)
      })
    }

    case 'browser_by_ref': {
      const ref = args?.ref as number
      const action = args?.action as string
      if (typeof ref !== 'number' || !action)
        throw new Error('browser_by_ref requires ref and action')
      const selector = await selectorFromRef(paneId, ref)
      const result = await performBrowserAction(paneId, action, { ...(args ?? {}), selector })
      return textJson({ ref, selector, action, result })
    }

    case 'browser_console_wait': {
      const timeout = (args?.timeout as number) || 5000
      const start = Date.now()
      while (Date.now() - start < timeout) {
        const match = getConsoleLogs(paneId).find((log) => {
          if (args?.type && log.type !== args.type) return false
          return matchesText(
            log.text,
            args?.text as string | undefined,
            args?.regex as string | undefined
          )
        })
        if (match) {
          if (args?.clear) clearConsoleLogs(paneId)
          return textJson({ success: true, log: match, elapsed: Date.now() - start })
        }
        await sleep(100)
      }
      return textJson({ success: false, reason: 'timeout', elapsed: timeout })
    }

    case 'browser_network_wait': {
      const timeout = (args?.timeout as number) || 5000
      const start = Date.now()
      while (Date.now() - start < timeout) {
        const match = getNetworkRequests(paneId).find((req) => {
          if (args?.method && req.method.toUpperCase() !== String(args.method).toUpperCase())
            return false
          if (typeof args?.status === 'number' && req.status !== args.status) return false
          return matchesText(
            req.url,
            args?.url as string | undefined,
            args?.regex as string | undefined
          )
        })
        if (match) {
          let body: unknown
          if (args?.includeBody) {
            try {
              body = await getNetworkResponseBody(paneId, match.requestId)
            } catch (e) {
              body = { error: String(e) }
            }
          }
          return textJson({ success: true, request: match, body, elapsed: Date.now() - start })
        }
        await sleep(100)
      }
      return textJson({ success: false, reason: 'timeout', elapsed: timeout })
    }

    case 'browser_route': {
      const action = args?.action as string
      if (action === 'list') return textJson({ routes: getRouteRules(paneId) })
      if (action === 'clear') {
        await clearRouteRules(paneId)
        return textJson({ success: true, routes: [] })
      }
      if (action === 'add') {
        const urlPattern = args?.urlPattern as string
        if (!urlPattern) throw new Error('browser_route add requires urlPattern')
        const rule: BrowserRouteRule = {
          id: (args?.id as string) || randomUUID(),
          urlPattern,
          method: args?.method as string | undefined,
          action: ((args?.routeAction as string) || 'mock') as BrowserRouteRule['action'],
          status: args?.status as number | undefined,
          headers: args?.headers as Record<string, string> | undefined,
          body: args?.body as string | undefined,
          contentType: args?.contentType as string | undefined
        }
        await addRouteRule(paneId, rule)
        return textJson({ success: true, rule })
      }
      throw new Error(`Unknown route action: ${action}`)
    }

    case 'browser_downloads': {
      const action = args?.action as string
      if (action === 'list') return textJson({ downloads: getDownloads(paneId) })
      if (action === 'clear') {
        clearDownloads(paneId)
        return textJson({ success: true, downloads: [] })
      }
      if (action === 'wait') {
        const timeout = (args?.timeout as number) || 10000
        const state = (args?.state as string) || 'completed'
        const start = Date.now()
        while (Date.now() - start < timeout) {
          const match = getDownloads(paneId).find((d) => d.state === state)
          if (match)
            return textJson({ success: true, download: match, elapsed: Date.now() - start })
          await sleep(200)
        }
        return textJson({
          success: false,
          reason: 'timeout',
          elapsed: timeout,
          downloads: getDownloads(paneId)
        })
      }
      throw new Error(`Unknown downloads action: ${action}`)
    }

    case 'browser_clipboard': {
      const action = args?.action as string
      if (action === 'read') return textJson({ text: clipboard.readText() })
      if (action === 'write') {
        clipboard.writeText((args?.text as string) ?? '')
        return textJson({ success: true })
      }
      if (action === 'clear') {
        clipboard.clear()
        return textJson({ success: true })
      }
      throw new Error(`Unknown clipboard action: ${action}`)
    }

    case 'browser_steps': {
      const steps = args?.steps as Array<Record<string, unknown>>
      if (!Array.isArray(steps)) throw new Error('browser_steps requires steps array')
      const continueOnError = args?.continueOnError === true
      const results: unknown[] = []
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]
        const action = step.action as string
        try {
          if (!action) throw new Error('step missing action')
          const result = await performBrowserAction(paneId, action, step)
          results.push({ index: i, action, success: true, result })
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e)
          results.push({ index: i, action, success: false, error })
          if (!continueOnError) return textJson({ success: false, stoppedAt: i, results })
        }
      }
      return textJson({ success: true, results })
    }

    default:
      throw new Error(`未知工具: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// SSE + HTTP Server
// ---------------------------------------------------------------------------

function setSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
}

function sendSseEvent(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\ndata: ${data}\n\n`)
}

function jsonRpcError(
  id: number | string | null | undefined,
  code: number,
  message: string
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message }
  }
}

function jsonRpcResult(id: number | string | null | undefined, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result
  }
}

function sendSseJsonRpc(res: ServerResponse, response: JsonRpcResponse): void {
  sendSseEvent(res, 'message', JSON.stringify(response))
}

function negotiateProtocolVersion(
  params: Record<string, unknown> | undefined,
  transport: McpSession['transport']
): string {
  const requested = params?.protocolVersion
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested)) {
    return requested
  }
  return transport === 'sse' ? '2024-11-05' : DEFAULT_PROTOCOL_VERSION
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rpc = value as Partial<JsonRpcRequest>
  return rpc.jsonrpc === '2.0' && typeof rpc.method === 'string'
}

async function handleJsonRpc(
  session: McpSession,
  req: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req
  const isNotification = id === undefined

  try {
    switch (method) {
      case 'initialize': {
        if (isNotification) return null
        const protocolVersion = negotiateProtocolVersion(params, session.transport)
        session.protocolVersion = protocolVersion
        return jsonRpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: `troupe-${session.kind}`,
            version: '0.2.0'
          }
        })
      }

      case 'tools/list':
        return isNotification ? null : jsonRpcResult(id, { tools: getToolsForKind(session.kind) })

      case 'tools/call': {
        const toolName = params?.name as string
        const toolArgs = params?.arguments as Record<string, unknown> | undefined

        if (!toolName) {
          return isNotification ? null : jsonRpcError(id, ERR_INVALID, '缺少 tool name')
        }

        if (!getToolsForKind(session.kind).some((tool) => tool.name === toolName)) {
          return isNotification
            ? null
            : jsonRpcError(id, ERR_METHOD, `工具不属于 ${session.kind} MCP: ${toolName}`)
        }

        try {
          const result = await handleToolCall(session, toolName, toolArgs)
          return isNotification ? null : jsonRpcResult(id, result)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          return isNotification
            ? null
            : jsonRpcResult(id, {
                content: [{ type: 'text', text: msg }],
                isError: true
              })
        }
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null

      case 'ping':
        return isNotification ? null : jsonRpcResult(id, {})

      default:
        return isNotification ? null : jsonRpcError(id, ERR_METHOD, `未知方法: ${method}`)
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return isNotification ? null : jsonRpcError(id, ERR_INTERNAL, msg)
  }
}

class RequestBodyTooLargeError extends Error {}

function pruneExpiredHttpSessions(now = Date.now()): void {
  for (const [sessionId, session] of httpSessions) {
    if (now - session.lastActivityAt > HTTP_SESSION_IDLE_TTL_MS) {
      httpSessions.delete(sessionId)
    }
  }
}

function startSessionCleanupTimer(): void {
  if (sessionCleanupTimer) return
  sessionCleanupTimer = setInterval(pruneExpiredHttpSessions, 60_000)
  sessionCleanupTimer.unref()
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_REQUEST_BODY_BYTES) {
        settled = true
        chunks.length = 0
        reject(new RequestBodyTooLargeError('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks, size).toString('utf8'))
    })
    req.on('error', (error) => {
      if (!settled) reject(error)
    })
  })
}

function startMcpServer(kind: McpServerKind, port: number): number {
  if (serverInstances.has(kind)) return port

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${MCP_HOST}:${port}`)

    // MCP 仅供本机进程使用。浏览器 Origin 即使拿到 URL 也不能调用高权限工具。
    if (!isMcpRequestOriginAllowed(req.headers)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', Vary: 'Origin' })
      res.end('Forbidden')
      return
    }

    if (!isMcpRequestAuthorized(req.headers, url, MCP_ACCESS_TOKEN)) {
      res.writeHead(401, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Bearer'
      })
      res.end('Unauthorized')
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(405, { Allow: 'GET, POST, DELETE', 'Content-Type': 'text/plain' })
      res.end('Method Not Allowed')
      return
    }

    // POST /mcp —— Streamable HTTP JSON-RPC 请求
    if (req.method === 'POST' && url.pathname === '/mcp') {
      if (!isJsonContentType(req.headers)) {
        res.writeHead(415, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(jsonRpcError(null, ERR_REQUEST, 'Content-Type 必须为 application/json'))
        )
        return
      }

      let value: unknown
      try {
        value = JSON.parse(await readBody(req))
      } catch (error) {
        const tooLarge = error instanceof RequestBodyTooLargeError
        res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            jsonRpcError(
              null,
              tooLarge ? ERR_REQUEST : ERR_PARSE,
              tooLarge ? '请求体过大' : '无效的 JSON'
            )
          )
        )
        return
      }

      if (!isJsonRpcRequest(value)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(jsonRpcError(null, ERR_REQUEST, '无效的 JSON-RPC 请求')))
        return
      }

      if (value.method === 'initialize' && value.id === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(jsonRpcError(null, ERR_REQUEST, 'initialize 必须包含请求 ID')))
        return
      }

      const headerSessionId = req.headers['mcp-session-id']
      const sessionId = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId
      let session: McpSession
      let createdSession = false

      if (value.method === 'initialize') {
        pruneExpiredHttpSessions()
        if (httpSessions.size >= MAX_HTTP_SESSIONS) {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '60' })
          res.end(JSON.stringify(jsonRpcError(value.id, ERR_INTERNAL, 'MCP session 数量已达上限')))
          return
        }
        session = {
          id: randomUUID(),
          kind,
          transport: 'http',
          paneId: url.searchParams.get('paneId') ?? undefined,
          accessToken: url.searchParams.get('token') ?? undefined,
          lastActivityAt: Date.now()
        }
        createdSession = true
      } else {
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(jsonRpcError(value.id, ERR_REQUEST, '缺少 Mcp-Session-Id')))
          return
        }

        let existingSession = httpSessions.get(sessionId)
        if (
          existingSession &&
          Date.now() - existingSession.lastActivityAt > HTTP_SESSION_IDLE_TTL_MS
        ) {
          httpSessions.delete(sessionId)
          existingSession = undefined
        }
        if (!existingSession || existingSession.kind !== kind) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(jsonRpcError(value.id, ERR_REQUEST, '未知或已过期的 session')))
          return
        }
        session = existingSession
        session.lastActivityAt = Date.now()

        const protocolHeader = req.headers['mcp-protocol-version']
        const protocolVersion = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader
        if (
          protocolVersion &&
          session.protocolVersion &&
          protocolVersion !== session.protocolVersion
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(jsonRpcError(value.id, ERR_REQUEST, 'MCP 协议版本不匹配')))
          return
        }
      }

      const response = await handleJsonRpc(session, value)
      if (createdSession) httpSessions.set(session.id, session)

      if (!response) {
        res.writeHead(202, {
          ...(createdSession ? { 'Mcp-Session-Id': session.id } : {})
        })
        res.end()
        return
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(createdSession ? { 'Mcp-Session-Id': session.id } : {}),
        ...(session.protocolVersion ? { 'MCP-Protocol-Version': session.protocolVersion } : {})
      })
      res.end(JSON.stringify(response))
      return
    }

    // Troupe 当前没有服务端主动消息，因此不为 Streamable HTTP 建立独立 SSE 流。
    if (req.method === 'GET' && url.pathname === '/mcp') {
      res.writeHead(405, {
        Allow: 'POST, DELETE',
        'Content-Type': 'text/plain'
      })
      res.end('Method Not Allowed')
      return
    }

    // DELETE /mcp —— 关闭 Streamable HTTP 会话
    if (req.method === 'DELETE' && url.pathname === '/mcp') {
      const headerSessionId = req.headers['mcp-session-id']
      const sessionId = Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('缺少 Mcp-Session-Id')
        return
      }
      const session = httpSessions.get(sessionId)
      if (!session || session.kind !== kind) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('未知或已过期的 session')
        return
      }
      httpSessions.delete(sessionId)
      res.writeHead(204)
      res.end()
      return
    }

    // GET /sse —— 建立 SSE 连接
    if (req.method === 'GET' && url.pathname === '/sse') {
      if (sseSessions.size >= MAX_SSE_SESSIONS) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '60' })
        res.end('MCP session 数量已达上限')
        return
      }
      const sessionId = randomUUID()
      setSseHeaders(res)

      const paneId = url.searchParams.get('paneId') ?? undefined
      const accessToken = url.searchParams.get('token') ?? undefined
      const session: SseSession = {
        id: sessionId,
        res,
        kind,
        transport: 'sse',
        paneId,
        accessToken,
        lastActivityAt: Date.now()
      }
      sseSessions.set(sessionId, session)

      const messageUrl = `http://${MCP_HOST}:${port}/message?sessionId=${sessionId}&auth=${encodeURIComponent(MCP_ACCESS_TOKEN)}`
      sendSseEvent(res, 'endpoint', messageUrl)

      req.on('close', () => {
        sseSessions.delete(sessionId)
      })

      return
    }

    // POST /message?sessionId=<id> —— 接收 JSON-RPC 请求
    if (req.method === 'POST' && url.pathname === '/message') {
      if (!isJsonContentType(req.headers)) {
        res.writeHead(415, { 'Content-Type': 'text/plain' })
        res.end('Content-Type 必须为 application/json')
        return
      }
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('缺少 ?sessionId= 参数')
        return
      }

      const session = sseSessions.get(sessionId)
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('未知或已过期的 session')
        return
      }
      session.lastActivityAt = Date.now()

      try {
        const raw = await readBody(req)
        const value = JSON.parse(raw) as unknown
        if (!isJsonRpcRequest(value)) throw new Error('invalid JSON-RPC request')
        res.writeHead(202, { 'Content-Type': 'text/plain' })
        res.end('Accepted')

        const response = await handleJsonRpc(session, value)
        if (response) sendSseJsonRpc(session.res, response)
      } catch (error) {
        const tooLarge = error instanceof RequestBodyTooLargeError
        res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'text/plain' })
        res.end(tooLarge ? '请求体过大' : '无效的 JSON-RPC 请求')
      }
      return
    }

    // 其他
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  server.on('error', (error) => {
    if (serverInstances.get(kind) === server) serverInstances.delete(kind)
    console.error(`[mcp] ${kind} MCP server failed on ${MCP_HOST}:${port}:`, error)
  })
  server.listen(port, MCP_HOST, () => {
    console.log(`[mcp] ${kind} MCP server listening on http://${MCP_HOST}:${port}/sse and /mcp`)
  })

  serverInstances.set(kind, server)
  return port
}

export function startMcpServers(): void {
  startSessionCleanupTimer()
  startMcpServer('browser', BROWSER_MCP_PORT)
  startMcpServer('agent', AGENT_MCP_PORT)
  startMcpServer('terminal', TERMINAL_MCP_PORT)
}

export function stopMcpServers(): void {
  if (sessionCleanupTimer) {
    clearInterval(sessionCleanupTimer)
    sessionCleanupTimer = null
  }
  for (const [, session] of sseSessions) {
    try {
      session.res.end()
    } catch {
      // ignore
    }
  }
  sseSessions.clear()
  httpSessions.clear()
  clearAgentState()

  for (const server of serverInstances.values()) {
    server.close()
  }
  serverInstances.clear()
}

export function getBrowserMcpPort(): number {
  return BROWSER_MCP_PORT
}

export function getAgentMcpPort(): number {
  return AGENT_MCP_PORT
}

export function getTerminalMcpPort(): number {
  return TERMINAL_MCP_PORT
}
