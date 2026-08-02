import { resolve } from 'path'
import { flushSettings, readSettings, updateSettings } from './settings'
import { assessSshCommandRisk } from './ssh-command-risk'
import type {
  SshCommandApprovalDecision,
  SshCommandApprovalRequest,
  SshCommandPermission,
  SshDirectoryPolicy
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

export function getSshDirectoryPolicy(directory: string): SshDirectoryPolicy {
  const wanted = directoryKey(directory)
  const entry = Object.entries(readSettings().sshDirectoryPermissions || {}).find(
    ([configured]) => directoryKey(configured) === wanted
  )
  return entry?.[1] === 'always_allow' || entry?.[1] === 'deny' ? entry[1] : 'ask'
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

function rememberDirectory(directory: string): void {
  const permissions = { ...(readSettings().sshDirectoryPermissions || {}) }
  for (const configured of Object.keys(permissions)) {
    if (directoryKey(configured) === directoryKey(directory)) delete permissions[configured]
  }
  permissions[directory] = 'always_allow'
  updateSettings({ sshDirectoryPermissions: permissions })
  flushSettings()
  permissionsChanged?.()
}

async function authorizeQueuedSshCommand(
  request: SshCommandApprovalRequest
): Promise<'directory' | 'command' | 'once'> {
  const directoryPolicy = getSshDirectoryPolicy(request.sourceDirectory)
  if (directoryPolicy === 'deny') {
    throw new Error(`当前目录已禁止 Agent 操作 SSH：${request.sourceDirectory}`)
  }
  const risk = assessSshCommandRisk(request.command)
  if (!risk.dangerous && directoryPolicy === 'always_allow') return 'directory'
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
    rememberDirectory(request.sourceDirectory)
    return risk.dangerous ? 'once' : 'directory'
  }
  return 'once'
}

export async function authorizeSshCommand(
  request: SshCommandApprovalRequest
): Promise<'directory' | 'command' | 'once'> {
  const pending = approvalQueue.then(() => authorizeQueuedSshCommand(request))
  approvalQueue = pending.then(
    () => undefined,
    () => undefined
  )
  return pending
}
