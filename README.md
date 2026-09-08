# Tau

**English** | [简体中文](./README.zh-CN.md)

A web UI that mirrors your [Pi](https://github.com/badlogic/pi-mono) terminal session in the browser. No separate server — it runs as a Pi extension inside your existing process.

![Tau dark mode](docs/images/dark.png)

![Tau terracotta theme](docs/images/terracotta.png)

![Settings](docs/images/settings.png)

![Commands](docs/images/commands.png)

## What it does

Tau connects to your running Pi TUI and gives you a second view in the browser. Same session, same messages, same tools — just a different screen. Type in the terminal or the browser; both stay in sync.

- **Live mirroring** — streams messages, tool calls, and thinking blocks in real time
- **Works on any device** — open it on your phone, tablet, or another monitor
- **Session browser** — view history from any past session; switch the live Pi session from the sidebar
- **No extra process** — the Pi extension *is* the server
- **Command system** — slash completion, Command Center, and Pi command dispatch
- **Session cover** — session prologue at the top of each session (UI-only, not written to history)

## Install

```bash
pi install npm:tau-mirror
```

Or from git:

```bash
pi install git:github.com/deflating/tau
```

For development, point Pi at a local clone via `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/absolute/path/to/tau"
  ],
  "tau": {
    "port": 38471,
    "autoOpenBrowser": true
  }
}
```

## Usage

1. Start Pi normally in your terminal
2. Tau opens your browser automatically at `http://127.0.0.1:38471` (status bar also shows the LAN URL)
3. That’s it

| Command / action | Description |
|------------------|-------------|
| `/tau` | Re-open the web UI |
| `/qr` | Show a phone QR code |
| `/tau-start` / `/tau-stop` | Start or stop the mirror server |
| `/tau-switch` | Arm the session-switch hook (run once if sidebar switch fails) |
| Close the Tau browser tab | Stops nothing by default — Pi keeps running; set `exitOnBrowserClose: true` to opt in to shutdown |
| `TAU_AUTO_OPEN=0` | Disable auto-open browser |

## Highlights

### Slash commands & Command Center

- Type `/` in the input to search Pi extensions, prompts, skills, and Tau actions
- Command button opens **PI COMMANDS** / **TAU ACTIONS** tabs
- Execution uses Pi’s public `getCommands()` plus a guarded adapter — slash commands are never sent as plain chat

### Session cover

A short cover appears at the top of each session (project, model, runtime). It is display-only and is not stored in session history.

### Session switch

Click a session in the sidebar to switch the live Pi TUI session via `switchSession`. If the first click does nothing, run `/tau-switch` once in the Pi terminal to arm the hook, then retry.

### UI

- Larger base fonts and stronger accent colors
- Light-theme link / skill styling improvements
- Dual-color slash input (transparent textarea + mirror under a solid bubble)

## Features

### Chat

- Full markdown with syntax-highlighted code blocks
- Streaming responses with typing indicator
- Image attachments (paste, drag & drop, or button)
- Copy any message with one click
- Inline diff viewer for edit tool calls
- Scroll-to-bottom with new-message indicator
- Message queuing while the agent is working

### Session management

- Browse past sessions grouped by project
- Full-text search with highlighted snippets
- Live session marked with a green dot
- Historical sessions are read-only
- Inline rename, favourites, tags, and filters
- Live switch of the Pi session from the sidebar

### Model & thinking

- Model picker with search and keyboard support
- Thinking level toggle (off / low / medium / high)
- Token usage and context window visualiser
- Cost tracking per session

### Voice, files, compaction, PWA

- Mic dictation (Web Speech API)
- Right sidebar file tree (lazy-loaded)
- Manual / auto context compaction
- Installable PWA with service worker and custom icons

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TAU_MIRROR_PORT` | `38471` | Server port (uncommon by design) |
| `TAU_HOST` | `127.0.0.1` | Bind address (loopback by default) |
| `TAU_REMOTE` | `0` | Set `1` to allow LAN/phone (`0.0.0.0` unless `TAU_HOST` is set) |
| `TAU_AUTO_OPEN` | `1` | Set `0` to skip opening the browser |
| `TAU_STATIC_DIR` | *(bundled)* | Override static files path |
| `TAU_DISABLED` | `0` | Set `1` to keep Tau installed but not auto-start |
| `TAU_USER` / `TAU_PASS` | *(none)* | HTTP Basic Auth (both required) |

### Network (personal-tool defaults)

By default Tau listens on **loopback only** (`127.0.0.1`). Same-machine browser use is unchanged.

To use a phone on the same Wi‑Fi or another device on the LAN, **explicitly enable remote**:

```bash
# environment
set TAU_REMOTE=1
# or permanently in settings.json: "remote": true
```

Setting `TAU_HOST=0.0.0.0` (or any non-loopback host) also enables remote for compatibility.

File browser and session delete stay limited to the workspace / sessions directory so ordinary UI paths keep working.

### `settings.json` (`~/.pi/agent/settings.json`)

```json
{
  "packages": ["C:/path/to/tau"],
  "tau": {
    "port": 38471,
    "remote": true,
    "autoOpenBrowser": true,
    "allowRemoteCommandExecution": false,
    "user": "pi",
    "pass": "your-password",
    "authEnabled": false
  }
}
```

- **`remote`**: set `true` (or `{ "enabled": true }`) for LAN/Tailscale/phone access; default is loopback-only
- **`allowRemoteCommandExecution`**: when auth is off, only local clients may run commands unless this is `true`
- **Basic Auth**: set `user` + `pass`, then enable “Require login” in Settings (or set `authEnabled`)

### Disable auto-start

```bash
TAU_DISABLED=1 pi
```

You can still start the server with `/tau-start` in that session.

## How it works

Tau is a [Pi extension](https://github.com/badlogic/pi-mono#extensions) that starts an HTTP + WebSocket server inside the Pi process. The extension subscribes to Pi events and forwards them to browser clients. Browser commands run against the same agent session.

```
┌─────────────┐     ┌──────────────────────────────┐     ┌─────────────┐
│  Pi TUI     │     │  Pi Process                  │     │  Browser    │
│  (terminal) │◄───►│                              │◄───►│  (Tau)      │
│             │     │  tau extension               │     │             │
└─────────────┘     │    ↳ HTTP + WS on :38471     │     └─────────────┘
                    └──────────────────────────────┘
```

No separate server process. The extension auto-loads with Pi and shuts down when Pi exits.

## Development

```bash
git clone https://github.com/deflating/tau.git
cd tau
# Point packages[] or TAU_STATIC_DIR at this tree
TAU_STATIC_DIR=$(pwd)/public pi   # Unix
# Windows PowerShell:
# $env:TAU_STATIC_DIR = "$PWD\public"; pi
```

Edit files under `public/` and refresh the browser. After changes to `extensions/mirror-server.ts`, clear the jiti cache and restart Pi:

```powershell
# Windows
Remove-Item "$env:LOCALAPPDATA\Temp\jiti" -Recurse -Force -ErrorAction SilentlyContinue
```


## License

MIT
