import { randomBytes } from 'crypto'

export const BROWSER_MCP_PORT = 9876
export const AGENT_MCP_PORT = 9877
export const TERMINAL_MCP_PORT = 9878
export const MCP_HOST = '127.0.0.1'
export const MCP_ACCESS_TOKEN = randomBytes(32).toString('hex')
