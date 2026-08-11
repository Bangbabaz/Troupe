import { app } from 'electron'
import { randomBytes } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const BROWSER_MCP_PORT = 9876
export const AGENT_MCP_PORT = 9877
export const TERMINAL_MCP_PORT = 9878
export const MCP_HOST = '127.0.0.1'

function loadMcpAccessToken(): string {
  const tokenPath = join(app.getPath('userData'), 'mcp-access-token')
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim()
    if (/^[a-f0-9]{64}$/i.test(existing)) {
      try {
        chmodSync(tokenPath, 0o600)
      } catch {
        // Windows ACL 由 userData 目录继承，chmod 可能不可用。
      }
      return existing
    }
  } catch {
    // 首次启动时创建。
  }

  const token = randomBytes(32).toString('hex')
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(tokenPath, 0o600)
    } catch {
      // Windows ACL 由 userData 目录继承，chmod 可能不可用。
    }
  } catch (error) {
    console.error('[mcp] 无法持久化 MCP 访问令牌，本次会话将使用临时令牌:', error)
  }
  return token
}

export const MCP_ACCESS_TOKEN = loadMcpAccessToken()
