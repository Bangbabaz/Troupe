import { resolve } from 'path'
import { flushSettings, readSettings, updateSettings } from './settings'
import { assessSshCommandRisk } from './ssh-command-risk'
import type {
  SshCommandApprovalDecision,
  SshCommandApprovalRequest,
  SshCommandPermission,
  SshServerPolicy
} from '@shared/types'

type ApprovalHandler = (request: SshCommandApprovalRequest) => Promise<SshCommandApprovalDecision>

let approvalHandler: ApprovalHandler | null = null
let permissionsChanged: (() => void) | null = null
let approvalQueue: Promise<void> = Promise.resolve()

function directoryKey(directory: string): string {
  const absolute = resolve(directory)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function setSshCommandApprovalHandler(handler: ApprovalHandler): void {
  approvalHandler = handler
}

export function setSshPermissionsChangedHandler(handler: () => void): void {
  permissionsChanged = handler
}

export function getSshServerPolicy(sshProfileId: string): SshServerPolicy {
  const policy = readSettings().sshServerPermissions?.[sshProfileId]
  return policy === 'always_allow' || policy === 'deny' ? policy : 'ask'
}

function findSavedCommand(request: SshCommandApprovalRequest): SshCommandPermission | undefined {
  const wantedDirectory = directoryKey(request.sourceDirectory)
  return (readSettings().sshCommandPermissions || []).find(
    (rule) =>
      directoryKey(rule.directory) === wantedDirectory &&
      rule.sshProfileId === request.sshProfileId &&
      rule.sshTarget === request.sshTarget &&
      rule.command === request.command
  )
}

function rememberServer(sshProfileId: string): void {
  const permissions = { ...(readSettings().sshServerPermissions || {}) }
  permissions[sshProfileId] = 'always_allow'
  updateSettings({ sshServerPermissions: permissions })
  flushSettings()
  permissionsChanged?.()
}

async function authorizeQueuedSshCommand(
  request: SshCommandApprovalRequest
): Promise<'server' | 'command' | 'once'> {
  const serverPolicy = getSshServerPolicy(request.sshProfileId)
  if (serverPolicy === 'deny') {
    throw new Error(`当前服务器已禁止 Agent 操作 SSH：${request.sshLabel}`)
  }
  const risk = assessSshCommandRisk(request.command)
  if (!risk.dangerous && serverPolicy === 'always_allow') return 'server'
  // Keep pre-0.7 exact-command grants working, but never let them bypass a risk prompt.
  if (!risk.dangerous && findSavedCommand(request)) return 'command'
  if (!approvalHandler) throw new Error('SSH 命令审批界面尚未就绪')

  const decision = await approvalHandler({
    ...request,
    dangerous: risk.dangerous,
    riskReason: risk.reason
  })
  if (decision === 'deny') throw new Error('用户拒绝了 SSH 命令')
  if (decision === 'always_allow') {
    rememberServer(request.sshProfileId)
    return risk.dangerous ? 'once' : 'server'
  }
  return 'once'
}

export async function authorizeSshCommand(
  request: SshCommandApprovalRequest
): Promise<'server' | 'command' | 'once'> {
  const pending = approvalQueue.then(() => authorizeQueuedSshCommand(request))
  approvalQueue = pending.then(
    () => undefined,
    () => undefined
  )
  return pending
}
