# Troupe

<p align="center">
  <img src="resources/icon.png" width="120" alt="Troupe logo" />
</p>

<p align="center">
  <strong>面向 Git、多任务开发与 AI Agent 协作的跨平台桌面终端。</strong>
</p>

<p align="center">
  分屏终端 · Git 工作树 · 后台任务 · 内置浏览器 · SSH · MCP 自动化
</p>

Troupe 基于 Electron、Vue 3 和 xterm.js 构建。它将终端分屏、Git 操作、工作树、
长期运行任务、浏览器预览以及 Agent 协作集中到一个工作区，适合同时维护多个分支、
开发服务和编码 Agent。

## 功能概览

| 能力         | 说明                                                            |
| ------------ | --------------------------------------------------------------- |
| 分屏终端     | 横向或纵向拆分面板，拖拽调整布局，每个面板维护独立会话与目录    |
| Git 工作流   | 分支切换、改动查看、提交历史、合并、变基、推送、拉取和冲突处理  |
| Git Worktree | 创建、打开、管理和删除工作树，并可直接在新面板中进入对应目录    |
| 后台任务     | 使用独立 PTY 运行长期命令，支持启动、停止、重启、日志查看和搜索 |
| 内置浏览器   | 每个终端面板拥有独立浏览器抽屉，可用于本地预览与 Agent 自动化   |
| 外部工具     | 自动检测 IDE、系统终端和文件管理器，每个面板独立保存打开方式    |
| SSH          | 保存远程连接配置，在独立面板中建立 SSH 终端                     |
| MCP          | 提供 Browser、Agent 和 Terminal 三组本地 MCP 服务               |

## 核心能力

### 分屏终端

- 任意横向或纵向拆分终端面板
- 拖动分隔线调整面板比例，拖动工具栏重新排列面板
- 每个面板拥有独立的 shell、工作目录、浏览器和外部工具选择
- 跟踪 shell 中的 `cd`，保存并恢复面板布局与目录
- 支持终端搜索、链接识别、Unicode 11 和 WebGL 渲染
- 支持可配置快捷键、字体大小和 scrollback 缓冲区

### Git 与工作树

- 显示当前仓库、分支、改动数量和合并状态
- 切换本地或远程分支，并为远程分支建立 tracking 关系
- 查看文件 diff、提交历史、提交详情和提交所属分支
- 执行 merge、rebase、push、pull、分支创建与删除
- 查看冲突文件，选择 ours/theirs，或进入三方内容处理流程
- 创建和管理 Git worktree，并将新工作树放入指定方向的新面板

### 后台任务与快捷指令

后台任务适合开发服务器、构建监听器等需要长期运行的命令：

- 按工作目录保存任务定义
- 使用独立 PTY 保留彩色输出和交互能力
- 启动、停止、重启、编辑和删除任务
- 多个面板共享任务运行状态
- 使用环形缓冲区保存日志并提供搜索
- 重启应用后保留任务定义，但不会自动重启进程

快捷指令用于保存常用命令，可选择填入当前终端或直接执行。

### 浏览器与外部工具

每个终端面板都可以打开独立浏览器抽屉，用于预览本地页面或调试 Web 应用。浏览器
支持地址导航、刷新、前进后退，并可交由 Browser MCP 操作。

Troupe 还会检测常见 IDE、系统终端和文件管理器。每个面板会独立保存“在 xx 中打开”
的选择，切换一个面板不会影响其他面板。

### SSH 与 Agent 会话

- 创建和复用 SSH 连接配置
- 在独立面板中打开远程终端
- 汇总本机 Claude Code 与 Codex 会话，并按当前目录筛选
- 从会话列表恢复 Agent 工作上下文
- 为 Agent 访问 SSH 提供目录策略、命令级审批和持久化授权规则

## MCP 集成

Troupe 仅在 `127.0.0.1` 上启动三组 MCP 服务，同时支持 legacy SSE 与 Streamable HTTP：

| 服务         | SSE                         | Streamable HTTP             | 用途                                       |
| ------------ | --------------------------- | --------------------------- | ------------------------------------------ |
| Browser MCP  | `http://127.0.0.1:9876/sse` | `http://127.0.0.1:9876/mcp` | 导航、点击、输入、截图、网络和页面状态读取 |
| Agent MCP    | `http://127.0.0.1:9877/sse` | `http://127.0.0.1:9877/mcp` | Agent 注册、发现、消息发送与回复           |
| Terminal MCP | `http://127.0.0.1:9878/sse` | `http://127.0.0.1:9878/mcp` | 经授权读取 SSH 输出并执行完整命令          |

### Claude Code

```bash
claude mcp add -s user -t sse troupe-browser http://127.0.0.1:9876/sse
claude mcp add -s user -t sse troupe-agent http://127.0.0.1:9877/sse
claude mcp add -s user -t sse troupe-terminal http://127.0.0.1:9878/sse
```

### Codex

```bash
codex mcp add troupe-browser --url http://127.0.0.1:9876/mcp
codex mcp add troupe-agent --url http://127.0.0.1:9877/mcp
codex mcp add troupe-terminal --url http://127.0.0.1:9878/mcp
```

也可以在 Troupe 的“设置 → MCP”中直接复制这些命令。注册后需要重启或刷新 Agent，
使其重新加载 MCP 工具列表。

### Agent 协作

Troupe 会向每个本地终端注入 `TROUPE_PANE_ID`，MCP 连接也会绑定来源面板。Agent 可通过：

- `agent_register` 注册唯一名称
- `agent_list` 查看在线且已注册的 Agent
- `agent_send` 向指定 Agent 发送消息并唤醒其终端
- `agent_reply` 回复已有会话

普通终端面板不会出现在 Agent 列表中。收到
`[TROUPE_AGENT_MESSAGE] ... [/TROUPE_AGENT_MESSAGE]` 包裹的内容时，应将其视为其他 Agent
发来的协作消息，而不是用户输入。

### Terminal MCP 安全边界

Terminal MCP 只面向已打开的 SSH 面板：

1. `terminal_list_ssh` 列出可用 SSH 终端及输出游标。
2. `terminal_read` 按游标增量读取原始输出。
3. `terminal_execute_command` 请求执行一条完整命令。

命令写入 PTY 前，Troupe 会校验来源面板、会话令牌、来源目录策略和命令风险。
“仅本次允许”只执行当前命令；“始终允许低风险命令”会保存当前来源目录，之后该目录的
低风险命令不再询问。危险命令不受目录授权和旧版精确命令规则影响，始终逐次确认。
相关策略可在“设置 → SSH 权限”中管理。

## 快捷键

| Windows / Linux     | macOS             | 功能         |
| ------------------- | ----------------- | ------------ |
| `Ctrl+Shift+D`      | `Cmd+Shift+D`     | 向右拆分面板 |
| `Ctrl+Shift+S`      | `Cmd+Shift+S`     | 向下拆分面板 |
| `Ctrl+Shift+W`      | `Cmd+Shift+W`     | 关闭当前面板 |
| `Ctrl+Shift+F`      | `Cmd+F`           | 搜索终端内容 |
| `Ctrl+=` / `Ctrl++` | `Cmd+=` / `Cmd++` | 增大终端字号 |
| `Ctrl+-`            | `Cmd+-`           | 减小终端字号 |
| `Ctrl+0`            | `Cmd+0`           | 重置终端字号 |
| `Ctrl+Shift+C`      | `Cmd+C`           | 复制选区     |
| `Ctrl+Shift+V`      | `Cmd+V`           | 粘贴         |

快捷键可以在设置中修改。发生冲突时，新绑定会与已有绑定交换。

## 安装

从 [GitHub Releases](https://github.com/Bangbabaz/Troupe/releases) 下载对应平台的安装包：

- Windows：NSIS 安装程序
- macOS：DMG
- Linux：AppImage、Snap 或 Deb

## 配置与数据

用户配置保存在：

```text
~/.troupe/settings.json
```

其中包括窗口状态、面板布局、后台任务、快捷指令、SSH 配置、主题和其他偏好。旧版本使用的
`~/.gittim` 或 `~/.Gittim` 会在启动时自动迁移到 `~/.troupe`。

## 许可证

Troupe 使用 [MIT License](LICENSE)。
