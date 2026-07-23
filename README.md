# Gittim

<p align="center">
  <img src="resources/icon.png" width="120" alt="Gittim logo" />
</p>

<p align="center">
  <strong>为 Git、多任务开发和 AI Agent 工作流设计的桌面终端。</strong>
</p>

<p align="center">
  分屏终端 · Git 工作树 · 后台命令 · 内置浏览器 · MCP 自动化 · 离线语音输入
</p>

---

Gittim 是一个基于 Electron 和 xterm.js 的跨平台终端应用。它把常用的 Git 操作、
工作树、长期运行命令、浏览器预览和 AI Agent 协作集中在一个窗口中，适合同时维护
多个分支、多个开发服务或多个编码 Agent 的工作方式。

## 主要功能

### 分屏终端

- 横向或纵向拆分任意数量的终端面板
- 拖动分隔线调整面板大小，拖动面板工具栏重新排列布局
- 每个面板拥有独立的 shell、工作目录和命令选择
- 自动跟踪 shell 中的 `cd`，重启后恢复布局和目录
- 支持终端搜索、链接识别、Unicode 11 和 WebGL 渲染

### Git 工作流

- 显示并切换当前仓库的本地、远程分支
- 远程分支自动建立 tracking 分支
- 切换前检测未提交修改，可选择暂存后继续
- 查看改动统计、文件 diff、提交历史和提交详情
- 创建、删除和管理 Git worktree
- 新建工作树后自动拆分面板并进入对应目录
- 支持 merge、rebase、push、pull、分支创建与删除
- 提供冲突状态查看和冲突文件处理入口

### 后台命令

将开发服务器、构建监听器等长期命令从可见终端中独立出来：

- 按工作目录保存命令定义
- 启动、停止、重启、编辑和删除命令
- 多个终端面板共享实时运行状态
- 使用独立 PTY 保留彩色输出和交互能力
- 日志使用环形缓冲区保存，并支持搜索
- 应用重启后保留命令定义，但不会自动启动进程

### 内置浏览器

每个终端面板都可以打开独立的浏览器抽屉，用于预览本地页面或调试 Web 应用。
浏览器支持地址导航、刷新、前进后退，并可通过内置 MCP 服务交给 AI Agent 操作。

### MCP 与 Agent 协作

Gittim 内置三个本地 MCP 服务：

| 服务         | Claude Code (SSE)           | Codex (Streamable HTTP)     | 用途                                       |
| ------------ | --------------------------- | --------------------------- | ------------------------------------------ |
| Browser MCP  | `http://127.0.0.1:9876/sse` | `http://127.0.0.1:9876/mcp` | 页面导航、点击、输入、截图和浏览器状态读取 |
| Agent MCP    | `http://127.0.0.1:9877/sse` | `http://127.0.0.1:9877/mcp` | 已注册 Agent 之间的终端唤醒式协作          |
| Terminal MCP | `http://127.0.0.1:9878/sse` | `http://127.0.0.1:9878/mcp` | 经用户授权读取 SSH 输出并执行完整命令      |

Claude Code 示例：

```bash
claude mcp add -s user -t sse gittim-browser http://127.0.0.1:9876/sse
claude mcp add -s user -t sse gittim-agent http://127.0.0.1:9877/sse
claude mcp add -s user -t sse gittim-terminal http://127.0.0.1:9878/sse
```

Codex 示例：

```bash
codex mcp add gittim-browser --url http://127.0.0.1:9876/mcp
codex mcp add gittim-agent --url http://127.0.0.1:9877/mcp
codex mcp add gittim-terminal --url http://127.0.0.1:9878/mcp
```

也可以在 Gittim 的“设置 → MCP”中直接复制对应命令。

Agent MCP 使用简化协作协议。Gittim 会在每个终端里注入 `GITTIM_PANE_ID`，Agent 注册时只需要：

- `agent_register({ name, paneId })` 注册一个轻量名称，例如 `planner`、`reviewer`；`paneId`
  从环境变量 `GITTIM_PANE_ID` 读取
- `agent_list()` 查看当前在线且已注册的 Agent
- `agent_send({ to, message, kind? })` 按注册名发送消息并唤醒目标 Agent
- `agent_reply({ conversationId, message, kind? })` 回复收到的协作消息

目标只会从已注册 Agent 中实时解析，不暴露普通终端面板。收到
`[GITTIM_AGENT_MESSAGE] ... [/GITTIM_AGENT_MESSAGE]` 包裹的内容时，应视为其他 Agent
通过 Gittim MCP 发来的协作消息，而不是用户输入。

Terminal MCP 使用 `terminal_list_ssh` 发现已打开的 SSH 面板，使用 `terminal_read`
按游标增量读取输出，使用 `terminal_execute_command` 提交单条完整命令。命令写入 PTY
前由 Gittim 强制检查来源目录权限；未配置时每次询问，“始终允许”会按来源目录、SSH
配置和完整命令保存精确规则。目录默认策略和已保存规则可在“设置 → SSH 权限”中管理。

### 离线语音输入

按住 `F2` 录音，松开后将识别结果安全粘贴到当前终端：

- 基于 whisper.cpp，本地离线运行
- 内置量化模型，无需在运行时下载
- 支持中英文混合识别
- 可选择麦克风设备
- 通过 xterm bracketed paste 写入，避免多行文本被 shell 意外逐行执行

### 快捷指令与外部工具

- 为常用命令配置快捷指令，并发送到当前终端
- 自动检测常见 IDE，可从当前目录直接打开
- 支持使用系统文件管理器打开当前目录
- Windows 上可使用系统 `cmd.exe` 在当前目录打开终端

## 快捷键

| 快捷键              | 功能                           |
| ------------------- | ------------------------------ |
| `Ctrl+Shift+D`      | 向右拆分面板                   |
| `Ctrl+Shift+S`      | 向下拆分面板                   |
| `Ctrl+Shift+W`      | 关闭当前面板                   |
| `Ctrl+F`            | 搜索终端内容                   |
| `Ctrl+=` / `Ctrl++` | 增大终端字号                   |
| `Ctrl+-`            | 减小终端字号                   |
| `Ctrl+0`            | 重置终端字号                   |
| `Ctrl+C`            | 有选区时复制，否则发送中断信号 |
| `Ctrl+V`            | 安全粘贴                       |
| 按住 `F2`           | 语音输入                       |

快捷键可以在设置中调整。

## 安装

从 [GitHub Releases](https://github.com/Bangbabaz/Gittim/releases) 下载对应平台的安装包：

- Windows：NSIS 安装程序
- macOS：DMG
- Linux：AppImage、Snap 或 Deb

## 本地开发

需要 Node.js、Yarn 1.x，以及平台对应的原生模块编译环境。

```bash
git clone https://github.com/Bangbabaz/Gittim.git
cd Gittim
```

Windows 首次安装依赖时必须使用包装脚本，它会为 MSVC 设置 UTF-8 编译参数：

```powershell
powershell ./scripts/install.ps1
```

macOS 和 Linux：

```bash
yarn install
```

常用命令：

```bash
yarn dev          # 启动开发环境
yarn typecheck    # TypeScript 类型检查
yarn lint         # ESLint
yarn format       # Prettier
yarn build        # 类型检查并构建
yarn build:win    # Windows 安装包
yarn build:mac    # macOS 安装包
yarn build:linux  # Linux 安装包
```

首次运行开发或构建命令时会自动下载离线语音模型。中国大陆网络环境可设置
`HF_MIRROR=hf-mirror.com`。

## 配置与数据

用户配置保存在：

```text
~/.gittim/settings.json
```

其中包括窗口状态、面板布局、后台命令、快捷指令、主题和其他偏好。旧版本使用的
`~/.Gittim` 会在应用启动时自动迁移到全小写目录。

语音模型存放在 `resources/models`，不提交到 Git，由下载脚本和打包流程管理。

## 技术栈

- Electron
- Vue 3 + TypeScript
- Element Plus
- xterm.js + node-pty
- electron-vite
- Shiki + diff2html
- whisper.cpp / smart-whisper

## 项目状态

Gittim 仍在持续开发中。欢迎通过
[Issues](https://github.com/Bangbabaz/Gittim/issues) 提交问题、功能建议或平台兼容性反馈。
