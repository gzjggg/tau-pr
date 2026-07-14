# Tau

[English](./README.md) | **简体中文**

在浏览器中镜像 [Pi](https://github.com/badlogic/pi-mono) 终端会话的 Web UI。无需独立服务进程——作为 Pi 扩展运行在现有进程内。

本仓库为 [deflating/tau](https://github.com/deflating/tau) 的维护分支，增加了命令系统、Hephaestus 风格会话封面、侧栏会话切换与 UI 打磨。

![Tau 深色模式](docs/images/dark.png)

![Tau 陶土主题](docs/images/terracotta.png)

![设置](docs/images/settings.png)

![命令](docs/images/commands.png)

## 能做什么

Tau 接入正在运行的 Pi TUI，在浏览器中提供同一会话的第二视图。消息、工具调用一致；在终端或浏览器输入都会同步。

- **实时镜像** — 消息、工具调用、思考块流式展示
- **多端可用** — 手机、平板或另一块显示器
- **会话浏览** — 查看历史会话；侧栏可切换当前 Pi 会话
- **无额外进程** — 扩展本身即是服务器
- **命令系统** — 斜杠补全、命令中心、Pi 命令派发
- **会话封面** — 类 Hephaestus 的会话开场（仅 UI，不写入历史）

## 安装

### 本分支（路径包，推荐）

在 Pi 配置中指向本地克隆目录：

```json
// ~/.pi/agent/settings.json
{
  "packages": [
    "C:/path/to/tau"
  ],
  "tau": {
    "port": 38471,
    "autoOpenBrowser": true
  }
}
```

macOS / Linux：

```json
{
  "packages": [
    "/absolute/path/to/tau"
  ]
}
```

### npm / git

```bash
# 上游包（若已发布）
pi install npm:tau-mirror

# 本分支
pi install git:github.com/gzjggg/tau
```

## 使用

1. 在终端正常启动 Pi  
2. Tau 自动打开浏览器：`http://127.0.0.1:38471`（状态栏也会显示局域网地址）  
3. 完成  

| 命令 / 操作 | 说明 |
|-------------|------|
| `/tau` | 重新打开 Web UI |
| `/qr` | 显示手机扫码二维码 |
| `/tau-start` / `/tau-stop` | 启动 / 停止镜像服务 |
| `/tau-switch` | 挂载会话切换钩子（侧栏切换失败时在终端执行一次） |
| 关闭 Tau 浏览器标签 | 关闭 Tau 端口并退出 Pi（sendBeacon） |
| `TAU_AUTO_OPEN=0` | 禁用自动打开浏览器 |

## 本分支亮点

### 斜杠命令与命令中心

- 输入框输入 `/` 可搜索 Pi 扩展、提示词、技能与 Tau 动作  
- 命令按钮打开 **PI COMMANDS** / **TAU ACTIONS**  
- 通过 Pi 的 `getCommands()` 与受保护适配器执行——斜杠命令不会当普通聊天发送  

### 会话封面

每个会话顶部展示简短的 Hephaestus 风格封面（项目、模型、时间等），仅展示，不写入会话历史。

### 会话切换

在侧栏点击会话，通过 `switchSession` 切换当前 Pi TUI 会话。若首次无效，在 Pi 终端执行一次 `/tau-switch` 挂载钩子后再试。

### UI

- 更大字号与更强强调色  
- 像素品牌标 
- 浅色主题链接 / 技能样式优化  
- 斜杠输入双色显示（透明 textarea + 底层镜像 + 实色气泡）  

## 功能一览

### 聊天

- Markdown 与代码高亮  
- 流式回复与输入指示  
- 图片附件（粘贴 / 拖放 / 按钮）  
- 一键复制消息  
- 编辑工具的行内 diff  
- 滚到底部与新消息提示  
- Agent 工作时消息排队  

### 会话管理

- 按项目分组浏览历史  
- 全文搜索与高亮片段  
- 当前会话绿点标记  
- 历史会话只读  
- 重命名、收藏、标签与筛选  
- 侧栏切换 live Pi 会话  

### 模型与思考

- 可搜索的模型选择器  
- 思考等级（off / low / medium / high）  
- Token 与上下文窗口可视化  
- 会话费用统计  

### 语音、文件、压缩、PWA

- 麦克风听写（Web Speech API）  
- 右侧懒加载文件树  
- 手动 / 自动上下文压缩  
- 可安装 PWA（Service Worker + 图标）  

## 配置

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `TAU_MIRROR_PORT` | `38471` | 服务端口（刻意避开常见端口） |
| `TAU_HOST` | `0.0.0.0` | 绑定地址；仅本机可设 `127.0.0.1` |
| `TAU_AUTO_OPEN` | `1` | 设为 `0` 跳过自动打开浏览器 |
| `TAU_STATIC_DIR` | *内置* | 覆盖静态资源路径 |
| `TAU_DISABLED` | `0` | 设为 `1` 安装但不自动启动 |
| `TAU_USER` / `TAU_PASS` | *无* | HTTP Basic Auth（需同时设置） |

### `settings.json`（`~/.pi/agent/settings.json`）

```json
{
  "packages": ["C:/path/to/tau"],
  "tau": {
    "port": 38471,
    "autoOpenBrowser": true,
    "allowRemoteCommandExecution": false,
    "user": "pi",
    "pass": "your-password",
    "authEnabled": false
  }
}
```

- **`allowRemoteCommandExecution`**：未启用认证时，仅本地客户端可执行命令，除非设为 `true`  
- **Basic Auth**：配置 `user` + `pass` 后，在设置里打开「Require login」，或设置 `authEnabled`  

### 禁止自动启动

```bash
TAU_DISABLED=1 pi
```

该会话中仍可用 `/tau-start` 手动启动。

## 工作原理

Tau 是 [Pi 扩展](https://github.com/badlogic/pi-mono#extensions)，在 Pi 进程内启动 HTTP + WebSocket 服务，订阅事件并转发给浏览器；浏览器命令在同一 Agent 会话中执行。

```
┌─────────────┐     ┌──────────────────────────────┐     ┌─────────────┐
│  Pi TUI     │     │  Pi 进程                     │     │  浏览器     │
│  (终端)     │◄───►│                              │◄───►│  (Tau)      │
│             │     │  tau 扩展                    │     │             │
└─────────────┘     │    ↳ HTTP + WS :38471        │     └─────────────┘
                    └──────────────────────────────┘
```

无需独立服务。扩展随 Pi 加载，Pi 退出或浏览器请求关闭时一并关闭。

## 开发

```bash
git clone https://github.com/gzjggg/tau.git
cd tau
# 用 packages[] 或 TAU_STATIC_DIR 指向本仓库
TAU_STATIC_DIR=$(pwd)/public pi   # Unix
# Windows PowerShell:
# $env:TAU_STATIC_DIR = "$PWD\public"; pi
```

修改 `public/` 后刷新浏览器即可。修改 `extensions/mirror-server.ts` 后请清理 jiti 缓存并重启 Pi：

```powershell
# Windows
Remove-Item "$env:LOCALAPPDATA\Temp\jiti" -Recurse -Force -ErrorAction SilentlyContinue
```

## 致谢

- 上游：[deflating/tau](https://github.com/deflating/tau)  
- Pi：[badlogic/pi-mono](https://github.com/badlogic/pi-mono)  

## 许可证

MIT
