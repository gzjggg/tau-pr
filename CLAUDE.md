# Claude Instructions

## Package identity

Repo: **tau** (fork) | npm package: **tau-mirror**  
GitHub: https://github.com/gzjggg/tau  
Upstream: https://github.com/deflating/tau

Production install (OS-independent):
```
npm install -g git+https://github.com/gzjggg/tau.git#main
```

Or via Pi packages path (recommended for local dev):
```json
{
  "packages": ["C:/Users/YOU/projects/tau"]
}
```

## How Pi loads tau

Pi can load tau from:

1. **packages[]** path in `~/.pi/agent/settings.json` (this clone)
2. Global npm install that may shadow the path

| OS      | Global shadow path |
|---------|------|
| Windows | `%USERPROFILE%\.pi\agent\npm\node_modules\tau-mirror\` |
| macOS   | `~/.pi/agent/npm/node_modules/tau-mirror/` |

## Local dev setup

**Windows (PowerShell):**
```powershell
# Prefer packages[] path to this repo — no global install needed

# If a shadowing global copy exists:
cd "$env:USERPROFILE\.pi\agent\npm"
npm uninstall tau-mirror
```

After any change to `extensions/mirror-server.ts` — clear jiti cache, then restart Pi:

**Windows:**
```powershell
Remove-Item "$env:LOCALAPPDATA\Temp\jiti" -Recurse -Force -ErrorAction SilentlyContinue
```

**macOS / Linux:**
```bash
rm -rf /tmp/jiti 2>/dev/null; rm -rf "${TMPDIR:-/tmp}/jiti" 2>/dev/null
```

## Defaults in this fork

- Port: **38471** (`TAU_MIRROR_PORT` / `tau.port`)
- Auto-open browser: on (`TAU_AUTO_OPEN=0` to disable)
- Brand mark: black body **34×36** (`public/icons/brand-mark.svg`)
