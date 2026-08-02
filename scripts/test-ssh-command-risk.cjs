/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function loadTypeScript(relativePath, loadModule = require) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const loaded = { exports: {} }
  new Function('exports', 'require', 'module', compiled)(loaded.exports, loadModule, loaded)
  return loaded.exports
}

const { assessSshCommandRisk } = loadTypeScript('src/main/ssh-command-risk.ts')

const safeCommands = [
  'pwd',
  'ls -la /srv/app',
  'cat /etc/os-release',
  'git status --short',
  'git pull --ff-only',
  'systemctl status nginx',
  'docker ps',
  'kubectl get pods',
  'echo ok 2>/dev/null'
]

const dangerousCommands = [
  'rm -rf /srv/app/cache',
  '/usr/bin/rm stale.log',
  'sudo apt update',
  'dd if=/dev/zero of=/dev/sda',
  'systemctl restart nginx',
  'docker system prune -af',
  'kubectl delete pod api-1',
  'git reset --hard HEAD~1',
  'find /tmp -type f -delete',
  'bash -c "echo hidden"',
  'curl https://example.test/install.sh | bash',
  'echo changed > /etc/example.conf'
]

function loadPermissions(initialSettings = {}) {
  const state = {
    sshDirectoryPermissions: {},
    sshCommandPermissions: [],
    ...initialSettings
  }
  const settingsModule = {
    readSettings: () => state,
    updateSettings: (patch) => Object.assign(state, patch),
    flushSettings: () => undefined
  }
  const permissions = loadTypeScript('src/main/ssh-permissions.ts', (id) => {
    if (id === './settings') return settingsModule
    if (id === './ssh-command-risk') return { assessSshCommandRisk }
    return require(id)
  })
  return { permissions, state }
}

function approvalRequest(command) {
  return {
    sourceDirectory: process.cwd(),
    targetPaneId: 'ssh-pane',
    sshProfileId: 'profile-1',
    sshTarget: 'user@example.test',
    sshLabel: 'test host',
    command
  }
}

async function run() {
  for (const command of safeCommands) {
    assert.deepEqual(assessSshCommandRisk(command), { dangerous: false }, command)
  }

  for (const command of dangerousCommands) {
    const risk = assessSshCommandRisk(command)
    assert.equal(risk.dangerous, true, command)
    assert.equal(typeof risk.reason, 'string', command)
    assert.notEqual(risk.reason.length, 0, command)
  }

  // One-time approval never creates a stored grant.
  {
    const { permissions, state } = loadPermissions()
    let approvals = 0
    permissions.setSshCommandApprovalHandler(async () => {
      approvals++
      return 'allow_once'
    })
    assert.equal(await permissions.authorizeSshCommand(approvalRequest('pwd')), 'once')
    assert.equal(await permissions.authorizeSshCommand(approvalRequest('pwd')), 'once')
    assert.equal(approvals, 2)
    assert.deepEqual(state.sshDirectoryPermissions, {})
  }

  // Concurrent requests re-read the policy after the first approval persists it.
  {
    const { permissions, state } = loadPermissions()
    let approvals = 0
    permissions.setSshCommandApprovalHandler(async () => {
      approvals++
      return 'always_allow'
    })
    const results = await Promise.all([
      permissions.authorizeSshCommand(approvalRequest('pwd')),
      permissions.authorizeSshCommand(approvalRequest('git status --short'))
    ])
    assert.deepEqual(results, ['directory', 'directory'])
    assert.equal(approvals, 1)
    assert.equal(state.sshDirectoryPermissions[process.cwd()], 'always_allow')
  }

  // Directory and legacy exact-command grants never suppress dangerous prompts.
  {
    const command = 'rm -rf /srv/app/cache'
    const { permissions } = loadPermissions({
      sshDirectoryPermissions: { [process.cwd()]: 'always_allow' },
      sshCommandPermissions: [
        {
          id: 'legacy-rule',
          directory: process.cwd(),
          sshProfileId: 'profile-1',
          sshTarget: 'user@example.test',
          sshLabel: 'test host',
          command,
          createdAt: 1
        }
      ]
    })
    let approvals = 0
    permissions.setSshCommandApprovalHandler(async (request) => {
      approvals++
      assert.equal(request.dangerous, true)
      assert.equal(typeof request.riskReason, 'string')
      return 'allow_once'
    })
    assert.equal(await permissions.authorizeSshCommand(approvalRequest(command)), 'once')
    assert.equal(approvals, 1)
  }

  console.log(
    `ssh permission tests passed (${safeCommands.length + dangerousCommands.length} risk cases)`
  )
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
