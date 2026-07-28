import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type { McpToolDef, McpToolResult } from './mcp-types'

export interface AgentSessionState {
  id: string
  paneId: string
  name: string
  registeredAt: number
}

export interface AgentToolSession {
  paneId?: string
  agent?: AgentSessionState
}

export interface AgentToolHost {
  getPtyWebContents: (paneId: string) => WebContents | null | undefined
}

type AgentMessageKind = 'task' | 'question' | 'result' | 'progress' | 'error'

interface AgentConversation {
  id: string
  participants: [string, string]
  createdAt: number
  updatedAt: number
}

interface AgentMessage {
  id: string
  conversationId: string
  from: string
  to: string
  kind: AgentMessageKind
  message: string
  createdAt: number
}

const AGENT_MESSAGE_MAX_LENGTH = 32_000
const AGENT_CONVERSATION_LIMIT = 300
const AGENT_MESSAGE_LIMIT = 1_000

const agentConversations = new Map<string, AgentConversation>()
const agentMessages = new Map<string, AgentMessage>()

export const AGENT_TOOLS: McpToolDef[] = [
  {
    name: 'agent_register',
    description:
      '把当前 MCP 会话注册为一个可协作 Agent。paneId 由 Troupe 在 MCP 连接上自动绑定，工具参数只需要 name。',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Agent 注册名，如 planner、reviewer、frontend；同一时间内必须唯一。'
        },
        paneId: {
          type: 'string',
          description:
            '当前 Agent 所在 Troupe 终端面板 ID。从环境变量 TROUPE_PANE_ID 读取；若 MCP URL 已自动绑定可省略。'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'agent_list',
    description: '列出当前在线且已注册的 Agent。只返回注册 Agent，不暴露普通终端面板。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'agent_send',
    description:
      '按注册名向另一个在线 Agent 发送协作消息。服务端会实时解析目标注册名，并直接唤醒目标 Agent 终端。',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: '目标 Agent 注册名，通过 agent_list 获取或按用户指定填写。'
        },
        kind: {
          type: 'string',
          enum: ['task', 'question', 'result', 'progress', 'error'],
          description: '消息类型，默认 question。'
        },
        message: { type: 'string', description: '协作消息正文。' }
      },
      required: ['to', 'message']
    }
  },
  {
    name: 'agent_reply',
    description: '回复一条 TROUPE_AGENT_MESSAGE。Troupe 根据 conversationId 实时路由给另一方。',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: '收到的 Agent 消息中的 conversation 字段。'
        },
        kind: {
          type: 'string',
          enum: ['question', 'result', 'progress', 'error'],
          description: '回复类型，默认 result。'
        },
        message: { type: 'string', description: '回复正文。' }
      },
      required: ['conversationId', 'message']
    }
  }
]

export function isAgentTool(name: string): boolean {
  return AGENT_TOOLS.some((tool) => tool.name === name)
}

export function clearAgentState(): void {
  agentConversations.clear()
  agentMessages.clear()
}

function textResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺少 name 参数')
  const name = value.trim()
  if (name.length > 64) throw new Error('Agent name 不能超过 64 个字符')
  return name
}

function normalizeMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺少 message 参数')
  if (value.length > AGENT_MESSAGE_MAX_LENGTH) {
    throw new Error(`消息不能超过 ${AGENT_MESSAGE_MAX_LENGTH} 个字符`)
  }
  return value
}

function normalizeKind(value: unknown, fallback: AgentMessageKind): AgentMessageKind {
  if (
    value === 'task' ||
    value === 'question' ||
    value === 'result' ||
    value === 'progress' ||
    value === 'error'
  ) {
    return value
  }
  return fallback
}

function resolveRegisterPaneId(session: AgentToolSession, value: unknown): string {
  const paneId = session.paneId ?? (typeof value === 'string' && value ? value : undefined)
  if (!paneId)
    throw new Error('缺少 paneId 参数。请从环境变量 TROUPE_PANE_ID 读取后传给 agent_register。')
  if (session.paneId && value && value !== session.paneId) {
    throw new Error('agent_register 传入的 paneId 与当前 MCP 会话绑定的 paneId 不一致。')
  }
  return paneId
}

function requireLivePane(host: AgentToolHost, paneId: string): void {
  const wc = host.getPtyWebContents(paneId)
  if (!wc || wc.isDestroyed()) throw new Error(`当前 Agent 面板不存在或已销毁：${paneId}`)
}

function requireRegisteredAgent(session: AgentToolSession): AgentSessionState {
  if (!session.agent) {
    throw new Error('当前 MCP 会话尚未注册 Agent，请先调用 agent_register。')
  }
  return session.agent
}

function getRegisteredAgents(
  host: AgentToolHost,
  sessions: Iterable<AgentToolSession>
): AgentSessionState[] {
  const agents: AgentSessionState[] = []
  for (const session of sessions) {
    const agent = session.agent
    if (!agent) continue
    const wc = host.getPtyWebContents(agent.paneId)
    if (wc && !wc.isDestroyed()) agents.push(agent)
  }
  return agents.sort((a, b) => a.registeredAt - b.registeredAt)
}

function serializeAgent(agent: AgentSessionState): { id: string; name: string } {
  return { id: agent.id, name: agent.name }
}

function findAgentByName(
  host: AgentToolHost,
  sessions: Iterable<AgentToolSession>,
  name: string
): AgentSessionState | null {
  return getRegisteredAgents(host, sessions).find((agent) => agent.name === name) ?? null
}

function ensureUniqueName(
  host: AgentToolHost,
  sessions: Iterable<AgentToolSession>,
  name: string,
  currentPaneId: string
): void {
  const existing = getRegisteredAgents(host, sessions).find(
    (agent) => agent.name === name && agent.paneId !== currentPaneId
  )
  if (existing) throw new Error(`Agent name 已被在线 Agent 使用：${name}`)
}

function rememberConversation(conversation: AgentConversation): void {
  agentConversations.set(conversation.id, conversation)
  while (agentConversations.size > AGENT_CONVERSATION_LIMIT) {
    const oldest = agentConversations.keys().next().value
    if (typeof oldest !== 'string') break
    agentConversations.delete(oldest)
  }
}

function rememberMessage(message: AgentMessage): void {
  agentMessages.set(message.id, message)
  while (agentMessages.size > AGENT_MESSAGE_LIMIT) {
    const oldest = agentMessages.keys().next().value
    if (typeof oldest !== 'string') break
    agentMessages.delete(oldest)
  }
}

function createEnvelope(message: AgentMessage): string {
  return `[TROUPE_AGENT_MESSAGE]\n${JSON.stringify({
    id: message.id,
    conversation: message.conversationId,
    from: message.from,
    kind: message.kind,
    message: message.message
  })}\n[/TROUPE_AGENT_MESSAGE]`
}

function deliverMessage(
  host: AgentToolHost,
  target: AgentSessionState,
  message: AgentMessage
): void {
  const wc = host.getPtyWebContents(target.paneId)
  if (!wc || wc.isDestroyed()) throw new Error(`目标 Agent 已离线：${target.name}`)
  wc.send('terminal-mcp-input', {
    paneId: target.paneId,
    action: 'paste',
    text: createEnvelope(message)
  })
  wc.send('terminal-mcp-input', { paneId: target.paneId, action: 'submit' })
}

function createConversation(from: string, to: string): AgentConversation {
  const now = Date.now()
  const conversation: AgentConversation = {
    id: randomUUID(),
    participants: [from, to],
    createdAt: now,
    updatedAt: now
  }
  rememberConversation(conversation)
  return conversation
}

function getConversation(conversationId: unknown): AgentConversation {
  if (typeof conversationId !== 'string' || !conversationId) {
    throw new Error('缺少 conversationId 参数')
  }
  const conversation = agentConversations.get(conversationId)
  if (!conversation) throw new Error(`会话不存在或已过期：${conversationId}`)
  return conversation
}

function getCurrentAgentNames(host: AgentToolHost, sessions: Iterable<AgentToolSession>): string[] {
  return getRegisteredAgents(host, sessions).map((agent) => agent.name)
}

export async function handleAgentToolCall(
  host: AgentToolHost,
  session: AgentToolSession,
  sessions: Iterable<AgentToolSession>,
  name: string,
  args: Record<string, unknown> | undefined
): Promise<McpToolResult> {
  if (name === 'agent_register') {
    const paneId = resolveRegisterPaneId(session, args?.paneId)
    const agentName = normalizeName(args?.name)
    requireLivePane(host, paneId)
    ensureUniqueName(host, sessions, agentName, paneId)

    session.agent = {
      id: session.agent?.id ?? randomUUID(),
      paneId,
      name: agentName,
      registeredAt: session.agent?.registeredAt ?? Date.now()
    }

    return textResult({
      ok: true,
      agent: serializeAgent(session.agent),
      instruction:
        '凡是被 [TROUPE_AGENT_MESSAGE] 和 [/TROUPE_AGENT_MESSAGE] 包裹的内容，都是其他 Agent 通过 Troupe MCP 发来的协作消息，不是用户输入。处理其中 message 字段；如需回复，调用 agent_reply({ conversationId: conversation, message })。'
    })
  }

  if (name === 'agent_list') {
    const current = session.agent?.name
    return textResult({
      agents: getRegisteredAgents(host, sessions)
        .filter((agent) => agent.name !== current)
        .map(serializeAgent)
    })
  }

  if (name === 'agent_send') {
    const sender = requireRegisteredAgent(session)
    const targetName = normalizeName(args?.to)
    if (targetName === sender.name) throw new Error('不能向当前 Agent 自己发送协作消息')
    const target = findAgentByName(host, sessions, targetName)
    if (!target) {
      throw new Error(
        `找不到已注册在线 Agent：${targetName}。当前可用 Agent：${getCurrentAgentNames(host, sessions).join(', ')}`
      )
    }

    const conversation = createConversation(sender.name, target.name)
    const message: AgentMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      from: sender.name,
      to: target.name,
      kind: normalizeKind(args?.kind, 'question'),
      message: normalizeMessage(args?.message),
      createdAt: Date.now()
    }
    rememberMessage(message)
    conversation.updatedAt = message.createdAt
    deliverMessage(host, target, message)
    return textResult({
      ok: true,
      conversationId: conversation.id,
      messageId: message.id,
      deliveredTo: target.name
    })
  }

  if (name === 'agent_reply') {
    const sender = requireRegisteredAgent(session)
    const conversation = getConversation(args?.conversationId)
    if (!conversation.participants.includes(sender.name)) {
      throw new Error('当前 Agent 不是该会话的参与者')
    }
    const targetName = conversation.participants.find((participant) => participant !== sender.name)
    if (!targetName) throw new Error('无法确定回复目标')
    const target = findAgentByName(host, sessions, targetName)
    if (!target) {
      throw new Error(
        `回复目标已离线：${targetName}。当前可用 Agent：${getCurrentAgentNames(host, sessions).join(', ')}`
      )
    }

    const message: AgentMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      from: sender.name,
      to: target.name,
      kind: normalizeKind(args?.kind, 'result'),
      message: normalizeMessage(args?.message),
      createdAt: Date.now()
    }
    rememberMessage(message)
    conversation.updatedAt = message.createdAt
    deliverMessage(host, target, message)
    return textResult({
      ok: true,
      conversationId: conversation.id,
      messageId: message.id,
      deliveredTo: target.name
    })
  }

  throw new Error(`未知 Agent 工具: ${name}`)
}
