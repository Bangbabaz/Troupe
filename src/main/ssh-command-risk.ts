export interface SshCommandRisk {
  dangerous: boolean
  reason?: string
}

interface RiskRule {
  pattern: RegExp
  reason: string
}

const COMMAND_PREFIX = String.raw`(?:^|[\s;&|()])(?:[^\s;&|()]+/)?`

function commandRule(commandPattern: string): RegExp {
  return new RegExp(String.raw`${COMMAND_PREFIX}(?:${commandPattern})(?=$|[\s;&|()])`, 'i')
}

const RISK_RULES: RiskRule[] = [
  {
    pattern: commandRule('sudo|doas|su'),
    reason: '命令会提升权限或切换系统身份'
  },
  {
    pattern: commandRule('rm|rmdir|unlink|shred|truncate|tee'),
    reason: '命令可能删除或覆盖远程文件'
  },
  {
    pattern: commandRule(
      String.raw`dd|wipefs|mkfs(?:\.[\w-]+)?|mkswap|fdisk|cfdisk|sfdisk|parted|sgdisk|lvremove|vgremove|pvremove`
    ),
    reason: '命令会直接修改磁盘、文件系统或卷'
  },
  {
    pattern: commandRule(String.raw`zpool\s+destroy|zfs\s+destroy`),
    reason: '命令会销毁存储池或文件系统'
  },
  {
    pattern: commandRule('shutdown|reboot|poweroff|halt|kexec|kill|pkill|killall'),
    reason: '命令会停止系统或进程'
  },
  {
    pattern: commandRule(String.raw`init\s+[06]`),
    reason: '命令会改变系统运行级别'
  },
  {
    pattern: new RegExp(
      String.raw`${COMMAND_PREFIX}systemctl\b[^;&|]*(?:\bstop\b|\brestart\b|\bdisable\b|\bmask\b|\breboot\b|\bpoweroff\b|\bhalt\b|\bkexec\b|\brescue\b|\bemergency\b)`,
      'i'
    ),
    reason: '命令会停止服务或改变系统启动状态'
  },
  {
    pattern: commandRule(String.raw`service\s+\S+\s+(?:stop|restart)`),
    reason: '命令会停止或重启远程服务'
  },
  {
    pattern: commandRule('chmod|chown|chgrp|setfacl|passwd|userdel|groupdel'),
    reason: '命令会修改权限、所有者或系统身份'
  },
  {
    pattern: commandRule('mount|umount|swapon|swapoff'),
    reason: '命令会修改挂载或交换空间状态'
  },
  {
    pattern: new RegExp(
      String.raw`${COMMAND_PREFIX}(?:docker|podman)\s+(?:(?:container|image|volume|network|system)\s+)?(?:rm|rmi|kill|stop|prune)\b`,
      'i'
    ),
    reason: '命令会删除或停止容器资源'
  },
  {
    pattern: commandRule(String.raw`(?:docker|podman)\s+compose\s+down`),
    reason: '命令会停止并移除容器编排资源'
  },
  {
    pattern: commandRule(String.raw`kubectl\s+(?:delete|drain|cordon)`),
    reason: '命令会删除集群资源或改变节点可调度状态'
  },
  {
    pattern: commandRule(String.raw`(?:apt|apt-get)\s+(?:remove|purge|autoremove)`),
    reason: '命令会移除系统软件包'
  },
  {
    pattern: commandRule(String.raw`(?:dnf|yum)\s+(?:remove|erase)|rpm\s+-e|pacman\s+-R`),
    reason: '命令会移除系统软件包'
  },
  {
    pattern: new RegExp(
      String.raw`${COMMAND_PREFIX}git\b[^;&|]*(?:\breset\s+--hard\b|\bclean\b|\bcheckout\s+--\b|\brestore\b|\bpush\b[^;&|]*\s(?:--force|-f)\b)`,
      'i'
    ),
    reason: '命令可能丢弃 Git 数据或强制覆盖远端历史'
  },
  {
    pattern: commandRule(String.raw`find\b[^;&|]*\s-delete`),
    reason: '命令会批量删除查找到的文件'
  },
  {
    pattern: commandRule(String.raw`sed\b[^;&|]*\s-i|perl\b[^;&|]*\s-pi`),
    reason: '命令会原地覆盖远程文件'
  },
  {
    pattern: commandRule(
      String.raw`eval|(?:ba|z|k|c)?sh\s+-c|python(?:\d+(?:\.\d+)?)?\s+-c|node\s+-e|perl\s+-e|ruby\s+-e`
    ),
    reason: '命令会动态执行脚本内容'
  },
  {
    pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:(?:[^\s|]+\/)?(?:ba|z|k|c)?sh)\b/i,
    reason: '命令会直接执行下载的脚本'
  }
]

const READ_ONLY_RULES = [
  /^(?:[^\s]+\/)?(?:pwd|whoami|id|uname|hostname|date|uptime|printenv|ls|cat|head|tail|wc|stat|file|du|df|readlink|realpath|which|whereis)(?:\s+.*)?$/i,
  /^(?:[^\s]+\/)?git(?:\s+-C\s+\S+)?\s+(?:status|log|diff|show|rev-parse|rev-list|ls-files|ls-tree|cat-file|describe)(?:\s+.*)?$/i,
  /^(?:[^\s]+\/)?systemctl(?:\s+--[\w=-]+)*\s+(?:status|is-active|is-enabled|show|list-units|list-unit-files)(?:\s+.*)?$/i,
  /^(?:[^\s]+\/)?service\s+\S+\s+status(?:\s+.*)?$/i,
  /^(?:[^\s]+\/)?(?:docker|podman)\s+(?:ps|images|inspect|logs|info|version)(?:\s+.*)?$/i,
  /^(?:[^\s]+\/)?kubectl(?:\s+--[\w=-]+)*\s+(?:get|describe|logs|top|api-resources|cluster-info|version)(?:\s+.*)?$/i,
  /^(?:[^\s]+\/)?(?:echo|printf|true|false)(?:\s+.*)?$/i
] as const

function hasFileRedirection(command: string): boolean {
  const withoutDevNull = command.replace(/(?:\d*>{1,2}|&>)\s*\/dev\/null\b/gi, '')
  return /(?:^|[^>])>{1,2}(?![>&])/.test(withoutDevNull)
}

function isKnownReadOnlyCommand(command: string): boolean {
  const withoutDevNull = command.replace(/(?:\d*>{1,2}|&>)\s*\/dev\/null\b/gi, '').trim()
  if (!withoutDevNull || /[;&|()<>`$\r\n]/.test(withoutDevNull)) return false
  return READ_ONLY_RULES.some((rule) => rule.test(withoutDevNull))
}

export function assessSshCommandRisk(command: string): SshCommandRisk {
  const normalized = command.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const matched = RISK_RULES.find((rule) => rule.pattern.test(normalized))
  if (matched) return { dangerous: true, reason: matched.reason }
  if (hasFileRedirection(normalized)) {
    return { dangerous: true, reason: '命令会写入或覆盖远程文件' }
  }
  if (isKnownReadOnlyCommand(normalized)) return { dangerous: false }
  return { dangerous: true, reason: '命令不在已知只读白名单中，需要逐次确认' }
}
