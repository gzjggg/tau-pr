/**
 * Mirror Server Extension
 *
 * BUILD_ID: tau-2026-07-14-no-exit-v3
 *
 * Starts a WebSocket + HTTP server inside the running Pi process,
 * allowing a browser to connect and mirror the TUI session in real-time.
 *
 * - Forwards all Pi events to connected browser clients
 * - Accepts commands from the browser and executes them via the extension API
 * - Serves static files for the Tau web UI
 * - Sends full state snapshot on client connect (messages, model, etc.)
 *
 * NEVER call process.exit from this file — browser close must not kill Pi.
 */
const TAU_BUILD_ID = "tau-2026-07-14-quiet-model-v10";

/** Routine logs only when TAU_DEBUG=1 (keeps TUI clean) */
const TAU_DEBUG =
  process.env.TAU_DEBUG === "1" || process.env.TAU_DEBUG === "true";
function mlog(...args: any[]) {
  if (TAU_DEBUG) console.log(...args);
}
function mwarn(...args: any[]) {
  // Always show real failures; soft operational noise stays behind TAU_DEBUG
  if (TAU_DEBUG) console.warn(...args);
}

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec, execFile } from "node:child_process";
import QRCode from "qrcode";
import {
  createPiCommandAdapter,
  refreshSessionCapture,
  resumeSessionLikeTui,
  newSessionLikeTui,
  sendPromptToLiveSession,
  type CommandDescriptor,
  type PiCommandAdapter,
} from "./pi-command-adapter";

// Load tau settings from ~/.pi/agent/settings.json (falls back to env vars)
function loadTauSettings(): {
  port: number;
  host: string;
  autoStart: boolean;
  autoOpenBrowser: boolean;
  user: string;
  pass: string;
  authEnabled?: boolean;
  projectsDir?: string;
  allowRemoteCommandExecution?: boolean;
  /** If true, closing the last browser tab can process.exit Pi. Default false (prevents startup 秒退). */
  exitOnBrowserClose?: boolean;
} {
  let settings: any = {};
  try {
    const home = os.homedir() || process.env.USERPROFILE || process.env.HOME || "";
    const settingsPath = path.join(home, ".pi", "agent", "settings.json");
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")).tau || {};
  } catch {}
  const autoOpenEnv = process.env.TAU_AUTO_OPEN;
  const autoOpenBrowser =
    autoOpenEnv === "0" || autoOpenEnv === "false"
      ? false
      : autoOpenEnv === "1" || autoOpenEnv === "true"
        ? true
        : settings.autoOpenBrowser !== false;
  const exitEnv = process.env.TAU_EXIT_ON_BROWSER_CLOSE;
  const exitOnBrowserClose =
    exitEnv === "1" || exitEnv === "true"
      ? true
      : exitEnv === "0" || exitEnv === "false"
        ? false
        : settings.exitOnBrowserClose === true;
  return {
    // 38471 — uncommon port to avoid clashes with typical dev servers (3000/3001/5173…)
    port: parseInt(process.env.TAU_MIRROR_PORT || String(settings.port || "38471"), 10),
    host: process.env.TAU_HOST || settings.host || "0.0.0.0",
    autoStart: !(
      process.env.TAU_DISABLED === "1" || process.env.TAU_DISABLED === "true" ||
      settings.disabled === true
    ),
    autoOpenBrowser,
    user: process.env.TAU_USER || settings.user || "",
    pass: process.env.TAU_PASS || settings.pass || "",
    authEnabled: settings.authEnabled,
    projectsDir: process.env.TAU_PROJECTS_DIR || settings.projectsDir,
    allowRemoteCommandExecution: settings.allowRemoteCommandExecution === true,
    exitOnBrowserClose,
  };
}

/** Cross-platform open URL in default browser */
function openInBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      exec(`cmd /c start "" "${url.replace(/"/g, "")}"`);
    } else if (process.platform === "darwin") {
      execFile("open", [url]);
    } else {
      execFile("xdg-open", [url]);
    }
  } catch (e) {
    console.warn("[Mirror] Failed to open browser:", (e as Error).message);
  }
}

const TAU_SETTINGS = loadTauSettings();
const PORT = TAU_SETTINGS.port;
const HOST = TAU_SETTINGS.host;
const TAU_AUTO_START = TAU_SETTINGS.autoStart;
const TAU_AUTO_OPEN = TAU_SETTINGS.autoOpenBrowser;
const AUTH_USER = TAU_SETTINGS.user;
const AUTH_PASS = TAU_SETTINGS.pass;
const AUTH_CONFIGURED = !!(AUTH_USER && AUTH_PASS);
let authEnabled = AUTH_CONFIGURED && TAU_SETTINGS.authEnabled !== false;
let browserOpenedOnce = false;
/** ms since mirror server started listening — used to ignore accidental exit beacons */
let serverStartedAt = 0;
/** Ignore any browser shutdown for this long after listen (old tabs / auto-open race) */
const EXIT_GRACE_MS = 60_000;
const TAU_EXIT_ON_BROWSER_CLOSE = TAU_SETTINGS.exitOnBrowserClose === true;
// @ts-ignore — __dirname is provided by jiti at runtime
const STATIC_DIR = process.env.TAU_STATIC_DIR || findPublicDir();

/**
 * MODULE-LEVEL singleton state.
 *
 * Pi re-invokes the extension factory on every session create/switch, which
 * would otherwise create a fresh `clients` Set while the browser stays connected
 * to the first HTTP/WS server — live events then go nowhere (GUI only updates
 * after a session switch triggers mirror_sync history load).
 *
 * Keep server/clients/latestCtx at module scope so every factory invocation
 * shares the same connected browsers.
 */
let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const clients = new Set<WebSocket>();
let latestCtx: ExtensionContext | null = null;
/** Live ExtensionAPI — updated on every factory invoke (session create/switch) */
let activePi: ExtensionAPI | null = null;
let mirrorUrl = "";
let tailscaleUrl = "";
let factoryInvokeCount = 0;

/** Always use the current session's ExtensionAPI (never a closed-over stale pi). */
function getApi(): ExtensionAPI {
  if (!activePi) {
    throw new Error("Pi ExtensionAPI not ready");
  }
  return activePi;
}

function findPublicDir(): string {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (dir: string) => {
      const normalized = path.resolve(dir);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push(normalized);
    };

    // 1) Common extension-relative paths
    addCandidate(path.resolve(__dirname, "public"));
    addCandidate(path.resolve(__dirname, "../public"));

    // 2) Installed package path (for npm-installed extension execution)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkgPath = require.resolve("tau-mirror/package.json");
      addCandidate(path.join(path.dirname(pkgPath), "public"));
    } catch {}

    // 3) Development fallback from current working directory
    addCandidate(path.resolve(process.cwd(), "public"));
    addCandidate(path.resolve(process.cwd(), "node_modules/tau-mirror/public"));

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
    }

    // Keep previous fallback behavior
    return path.resolve(process.cwd(), "public");
}
const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(USER_HOME, ".pi", "agent");
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_AGENT_DIR, "sessions");
const INSTANCES_DIR = path.join(USER_HOME, ".pi", "tau-instances");

// Instance registry — tracks all running Tau servers
function registerInstance(port: number, sessionFile: string, cwd: string) {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
  const info = { port, pid: process.pid, sessionFile, cwd, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(INSTANCES_DIR, `${process.pid}.json`), JSON.stringify(info));
}

function updateInstanceSession(sessionFile: string, cwd?: string) {
  const file = path.join(INSTANCES_DIR, `${process.pid}.json`);
  if (!fs.existsSync(file)) return;
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    info.sessionFile = sessionFile;
    if (cwd) info.cwd = cwd;
    fs.writeFileSync(file, JSON.stringify(info));
  } catch {}
}

function unregisterInstance() {
  try { fs.unlinkSync(path.join(INSTANCES_DIR, `${process.pid}.json`)); } catch {}
}

function getRunningInstances(): Array<{ port: number; pid: number; sessionFile: string; cwd: string }> {
  if (!fs.existsSync(INSTANCES_DIR)) return [];
  const instances: any[] = [];
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Own process is always alive — never probe with kill(self, 0)
      if (info.pid === process.pid) {
        instances.push(info);
        continue;
      }
      // Signal 0 = existence check only (does not terminate)
      try {
        process.kill(info.pid, 0);
        instances.push(info);
      } catch {
        // Process dead — clean up stale file
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
      }
    } catch {}
  }
  return instances;
}

/**
 * Kill zombie Tau instances — processes that are alive but orphaned
 * (e.g. tmux pane was killed without session_shutdown firing).
 * A zombie is detected by checking if the process has a controlling terminal.
 * If it doesn't, the HTTP server is the only thing keeping it alive.
 */
function cleanupZombieInstances() {
  if (process.platform === "win32") return;
  if (!fs.existsSync(INSTANCES_DIR)) return;
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Skip our own process
      if (info.pid === process.pid) continue;
      // Check if process is alive
      try {
        process.kill(info.pid, 0);
      } catch {
        // Already dead — clean up
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
        continue;
      }
      // Use shared zombie detection
      if (isZombieProcess(info.pid)) {
        console.log(`[Mirror] Killing zombie Tau instance (PID ${info.pid}, port ${info.port})`);
        process.kill(info.pid, "SIGTERM");
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
      }
    } catch {}
  }
}

function isZombieProcess(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    const { execSync } = require("node:child_process");
    const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: "utf8" }).trim();
    return !tty || tty === "??" || tty === "-";
  } catch {
    return true;
  }
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function saveTauSetting(key: string, value: any) {
  const home = os.homedir() || process.env.USERPROFILE || process.env.HOME || "";
  const settingsPath = path.join(home, ".pi", "agent", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!settings.tau) settings.tau = {};
    settings.tau[key] = value;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {}
}

function checkBasicAuth(req: http.IncomingMessage): boolean {
  if (!authEnabled) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  if (colon === -1) return false;
  return decoded.slice(0, colon) === AUTH_USER && decoded.slice(colon + 1) === AUTH_PASS;
}

function sendAuthRequired(res: http.ServerResponse) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Tau"',
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export default function (pi: ExtensionAPI) {
  factoryInvokeCount++;
  // Critical: keep a live API pointer for HTTP/WS handlers started by the first factory
  activePi = pi;
  mlog(
    `[Mirror] factory invoke #${factoryInvokeCount} (shared clients=${clients.size}, server=${server ? "up" : "down"})`
  );

  // Install session-switch hooks ASAP (before interactive mode binds command context)
  try {
    createPiCommandAdapter(pi as any);
  } catch (e) {
    console.warn("[Mirror] Early adapter init:", (e as Error).message);
  }

  // NOTE: server / wss / clients / latestCtx / mirrorUrl are MODULE-LEVEL (see top).
  // Do not redeclare them here — session switch re-runs this factory.

  /**
   * Arm sidebar resume. NEVER close over ExtensionCommandContext — it goes stale
   * after switchSession. Prefer interactive bind capture inside resumeSessionLikeTui.
   */
  function armSessionSwitcher(ctx: { switchSession: (p: string, o?: any) => Promise<any> }) {
    // Warm capture patches (bindCommandContext / runner) without storing this ctx
    try {
      refreshSessionCapture(ctx as any, pi as any);
      pi.getCommands?.();
    } catch { /* ignore */ }
    mlog("[Mirror] Resume hooks warmed");
  }

  // Args: absolute path to session .jsonl. No args = warm hooks only.
  pi.registerCommand("tau-switch", {
    description:
      "Resume a session like TUI /resume (pick). Args: absolute session .jsonl path. Used by Tau Web sidebar.",
    handler: async (args, ctx) => {
      armSessionSwitcher(ctx);
      const target = (args || "").trim().replace(/^["']|["']$/g, "");
      // Notify BEFORE switch — after switch this ctx is invalid
      if (!target) {
        try {
          ctx.ui.notify("Tau resume hook ready — sidebar can resume same-cwd sessions", "info");
        } catch { /* ignore */ }
        return;
      }
      const liveCwd = (ctx as any).cwd || process.cwd();
      try {
        const result = await resumeSessionLikeTui(target, {
          requireSameCwd: true,
          liveCwd,
          onNewSession: (newCtx) => {
            latestCtx = newCtx;
          },
        });
        // Do NOT touch `ctx` after resume — it is stale. Use latestCtx / console only.
        if (result.cancelled) {
          mwarn("[Tau] /tau-switch cancelled");
          return;
        }
        if (!result.ok) {
          mwarn("[Tau] /tau-switch failed:", result.error);
          return;
        }
        mlog("[Tau] /tau-switch ok", result.newSessionFile || target);
      } catch (e: any) {
        console.warn("[Tau] /tau-switch error:", e);
      }
    },
  });

  // Command discovery / execution (Pi adapter + Tau actions)
  const commandAdapter: PiCommandAdapter = createPiCommandAdapter(pi as any);
  let commandsCache: { at: number; commands: CommandDescriptor[]; adapter: ReturnType<PiCommandAdapter["info"]> } | null = null;
  const COMMANDS_TTL_MS = 30_000;
  let gitCache: { at: number; branch?: string; dirty?: boolean } | null = null;

  const TAU_ACTIONS: CommandDescriptor[] = [
    { id: "tau:settings", name: "settings", invocation: "/tau:settings", description: "Open Tau Web settings (theme, display)", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: true },
    { id: "tau:model", name: "model", invocation: "/tau:model", description: "Open Tau Web model picker", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: true },
    { id: "tau:thinking", name: "thinking", invocation: "/tau:thinking", description: "Cycle Tau Web thinking level", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: true },
    { id: "tau:compact", name: "compact", invocation: "/tau:compact", description: "Compact context to save tokens", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: false },
    { id: "tau:export-html", name: "export-html", invocation: "/tau:export-html", description: "Export session as HTML file", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: true },
    { id: "tau:session-stats", name: "session-stats", invocation: "/tau:session-stats", description: "Show session statistics", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: true },
    { id: "tau:expand-tools", name: "expand-tools", invocation: "/tau:expand-tools", description: "Expand all tool cards", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: true },
    { id: "tau:collapse-tools", name: "collapse-tools", invocation: "/tau:collapse-tools", description: "Collapse all tool cards", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: true },
    { id: "tau:refresh-commands", name: "refresh-commands", invocation: "/tau:refresh-commands", description: "Refresh command list", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: true },
    { id: "tau:toggle-cover", name: "toggle-cover", invocation: "/tau:toggle-cover", description: "Toggle session cover", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: true },
    { id: "tau:scroll-start", name: "scroll-start", invocation: "/tau:scroll-start", description: "Scroll to session start", source: "tau", location: "builtin", capability: "execute", acceptsArgs: false, availableWhileStreaming: true },
  ];

  async function listAllCommands(refresh = false): Promise<{ commands: CommandDescriptor[]; adapter: ReturnType<PiCommandAdapter["info"]> }> {
    if (!refresh && commandsCache && Date.now() - commandsCache.at < COMMANDS_TTL_MS) {
      return { commands: commandsCache.commands, adapter: commandsCache.adapter };
    }
    refreshSessionCapture(latestCtx || undefined, pi as any);
    let piCommands: CommandDescriptor[] = [];
    try {
      piCommands = await commandAdapter.list();
    } catch (e) {
      mwarn("[Mirror] Command discovery failed:", (e as Error).message);
    }
    // Merge: Tau actions first, then Pi (dedupe by invocation)
    const seen = new Set<string>();
    const merged: CommandDescriptor[] = [];
    for (const c of [...TAU_ACTIONS, ...piCommands]) {
      const key = c.invocation.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
    }
    const adapter = commandAdapter.info();
    commandsCache = { at: Date.now(), commands: merged, adapter };
    return { commands: merged, adapter };
  }

  function invalidateCommands(reason: string) {
    commandsCache = null;
    broadcast({ type: "event", event: { type: "commands_changed", reason } });
  }

  async function getGitInfo(cwd: string): Promise<{ branch?: string; dirty?: boolean }> {
    if (gitCache && Date.now() - gitCache.at < 60_000) {
      return { branch: gitCache.branch, dirty: gitCache.dirty };
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({}), 500);
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 450 }, (err, stdout) => {
        if (err) {
          clearTimeout(timeout);
          gitCache = { at: Date.now() };
          resolve({});
          return;
        }
        const branch = (stdout || "").trim() || undefined;
        execFile("git", ["status", "--porcelain"], { cwd, timeout: 450 }, (err2, statusOut) => {
          clearTimeout(timeout);
          const dirty = err2 ? undefined : !!(statusOut || "").trim();
          gitCache = { at: Date.now(), branch, dirty };
          resolve({ branch, dirty });
        });
      });
    });
  }

  async function buildSessionCover(ctx: ExtensionContext | null) {
    const model = ctx?.model as any;
    const usage = ctx?.getContextUsage?.() as any;
    const cwd = ctx?.cwd || process.cwd();
    const git = await getGitInfo(cwd);
    let resourceCounts = { extensions: 0, prompts: 0, skills: 0 };
    try {
      const { commands } = await listAllCommands(false);
      resourceCounts = {
        extensions: commands.filter((c) => c.source === "extension").length,
        prompts: commands.filter((c) => c.source === "prompt").length,
        skills: commands.filter((c) => c.source === "skill").length,
      };
    } catch { /* ignore */ }

    let tauVersion = "1.0.9";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, "..", "package.json"), "utf8"));
      tauVersion = pkg.version || tauVersion;
    } catch { /* ignore */ }

    let piVersion: string | undefined;
    try {
      const { createRequire } = await import("node:module");
      // jiti provides a usable base path via __filename when available
      const base = typeof __filename !== "undefined" ? __filename : path.join(STATIC_DIR, "index.js");
      const req = createRequire(base);
      for (const name of ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]) {
        try {
          const p = req.resolve(`${name}/package.json`);
          piVersion = JSON.parse(fs.readFileSync(p, "utf8")).version;
          break;
        } catch { /* next */ }
      }
    } catch { /* ignore */ }

    const tokens = usage?.tokens ?? usage?.input ?? usage?.total;
    const contextWindow = usage?.contextWindow ?? usage?.context_window;
    const percent =
      tokens != null && contextWindow
        ? Math.round((Number(tokens) / Number(contextWindow)) * 100)
        : usage?.percent;

    let sessionName: string | undefined;
    let thinkingLevel: string | undefined;
    try {
      const api = getApi();
      sessionName = api.getSessionName?.() || undefined;
      thinkingLevel = api.getThinkingLevel?.() as string | undefined;
    } catch {
      try {
        sessionName = pi.getSessionName?.() || undefined;
        thinkingLevel = pi.getThinkingLevel?.() as string | undefined;
      } catch { /* ignore */ }
    }

    return {
      sessionName,
      cwd,
      projectName: path.basename(cwd),
      model: model
        ? {
            provider: model.provider,
            id: model.id,
            displayName: model.name || model.id,
          }
        : undefined,
      thinkingLevel,
      contextUsage: {
        tokens: tokens != null ? Number(tokens) : undefined,
        contextWindow: contextWindow != null ? Number(contextWindow) : undefined,
        percent: percent != null ? Number(percent) : undefined,
      },
      runtime: { piVersion, tauVersion },
      git,
      resources: resourceCounts,
      generatedAt: Date.now(),
    };
  }

  // Pending RPC-style requests from browser (id -> resolver)
  const pendingRequests = new Map<string, (response: any) => void>();

  // ═══════════════════════════════════════
  // Helper: send to one client
  // ═══════════════════════════════════════
  function sendTo(ws: WebSocket, data: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // ═══════════════════════════════════════
  // Helper: broadcast to all clients
  // ═══════════════════════════════════════
  function safeStringify(data: any): string | null {
    try {
      return JSON.stringify(data);
    } catch {
      // Agent message objects can occasionally contain cycles / BigInt
      try {
        const seen = new WeakSet();
        return JSON.stringify(data, (_k, v) => {
          if (typeof v === "bigint") return v.toString();
          if (typeof v === "object" && v !== null) {
            if (seen.has(v)) return undefined;
            seen.add(v);
          }
          return v;
        });
      } catch (e2) {
        mwarn("[Mirror] broadcast JSON failed:", e2);
        return null;
      }
    }
  }

  function broadcast(data: any) {
    const json = safeStringify(data);
    if (!json) return;
    let sent = 0;
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(json);
          sent++;
        } catch (e) {
          mwarn("[Mirror] client.send failed:", e);
        }
      }
    }
    if (sent === 0 && clients.size > 0) {
      // clients exist but none OPEN — useful debug
    }
  }

  /** Slim event payload for high-frequency streaming (avoids huge/circular message blobs) */
  function eventPayloadForBrowser(eventType: string, event: any): any {
    if (!event || typeof event !== "object") return { type: eventType };
    // message_update: only need deltas for live UI
    if (eventType === "message_update") {
      return {
        type: "message_update",
        assistantMessageEvent: event.assistantMessageEvent,
        // include message role only (full message is huge / can fail to stringify)
        message: event.message
          ? { role: event.message.role, id: event.message.id }
          : undefined,
      };
    }
    if (eventType === "message_start" || eventType === "message_end") {
      return {
        type: eventType,
        message: event.message,
      };
    }
    if (
      eventType === "tool_execution_start" ||
      eventType === "tool_execution_update" ||
      eventType === "tool_execution_end"
    ) {
      return {
        type: eventType,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
        result: event.result,
        isError: event.isError,
      };
    }
    // Default: shallow copy + force type
    return { ...event, type: eventType };
  }

  // ═══════════════════════════════════════
  // Helper: stop the server
  // ═══════════════════════════════════════
  function stopServer() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (wss) {
      for (const client of clients) {
        client.close();
      }
      clients.clear();
      wss.close();
      wss = null;
    }
    if (server) {
      server.close();
      server = null;
    }
    unregisterInstance();
    mirrorUrl = "";
    tailscaleUrl = "";
  }

  // ═══════════════════════════════════════
  // /tau-stop and /tau-start commands
  // ═══════════════════════════════════════
  pi.registerCommand("taustop", {
    description: "Stop the Tau mirror server",
    handler: async (_args, ctx) => {
      armSessionSwitcher(ctx);
      if (!server) {
        ctx.ui.notify("Tau is not running", "warning");
        return;
      }
      stopServer();
      ctx.ui.setStatus("mirror", "");
      ctx.ui.notify("Tau mirror server stopped", "info");
      mlog("[Mirror] Server stopped via /taustop");
    },
  });

  pi.registerCommand("taustart", {
    description: "Start the Tau mirror server",
    handler: async (_args, ctx) => {
      armSessionSwitcher(ctx);
      if (server) {
        ctx.ui.notify(`Tau is already running at ${mirrorUrl}`, "warning");
        return;
      }
      startServer(ctx);
      ctx.ui.notify("Tau mirror server starting...", "info");
    },
  });

  // ═══════════════════════════════════════
  // /qr command — show QR code to connect
  // ═══════════════════════════════════════
  pi.registerCommand("tau", {
    description: "Open Tau web UI in browser",
    handler: async (_args, ctx) => {
      armSessionSwitcher(ctx);
      if (!mirrorUrl) {
        ctx.ui.notify("Mirror server not running yet", "warning");
        return;
      }
      // Prefer loopback for local open
      const openUrl = mirrorUrl.replace(/^http:\/\/[^/]+/, (m) => {
        try {
          const u = new URL(mirrorUrl);
          return `http://127.0.0.1:${u.port || PORT}`;
        } catch {
          return m;
        }
      });
      openInBrowser(openUrl);
      ctx.ui.notify(`Opened ${openUrl}`, "info");
    },
  });

  pi.registerCommand("qr", {
    description: "Show QR code for Tau mirror URL",
    handler: async (_args, ctx) => {
      if (!mirrorUrl) {
        ctx.ui.notify("Mirror server not running yet", "warning");
        return;
      }
      const qrPageUrl = `${mirrorUrl}/api/qr`;
      ctx.ui.notify(`Tau: ${mirrorUrl}  •  QR: ${qrPageUrl}`, "info");
      openInBrowser(qrPageUrl);
    },
  });

  // ═══════════════════════════════════════
  // Event forwarding — subscribe to all Pi events
  // ═══════════════════════════════════════
  const eventTypes = [
    "agent_start", "agent_end",
    "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "auto_compaction_start", "auto_compaction_end",
    "auto_retry_start", "auto_retry_end",
    "model_select",
  ] as const;

  for (const eventType of eventTypes) {
    pi.on(eventType as any, async (event: any, ctx: ExtensionContext) => {
      try {
        if (ctx) latestCtx = ctx;
      } catch {
        /* stale ctx after switch — ignore */
      }

      try {
        const payload = eventPayloadForBrowser(eventType, event);
        broadcast({ type: "event", event: payload });
      } catch (e) {
        mwarn(`[Mirror] broadcast ${eventType} failed:`, e);
      }
    });
  }

  // Also capture context from session events
  // Auto-title: collect user messages and generate a title after a few turns
  let turnCount = 0;
  let titleSet = false;
  let userMessages: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    turnCount = 0;
    titleSet = false;
    userMessages = [];
    // Update instance registry with new session file
    updateInstanceSession(ctx.sessionManager.getSessionFile() || "");
  });

  pi.on("turn_start", async (_event, _ctx) => {
    turnCount++;
  });

  // Capture user messages for title generation via message_start
  pi.on("message_start", async (event, _ctx) => {
    if (titleSet) return;
    const msg = event.message;
    if (!msg || msg.role !== "user") return;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const tb = content.find((b: any) => b.type === "text");
      if (tb) text = tb.text;
    }
    if (text) userMessages.push(text.substring(0, 300));
  });

  pi.on("turn_end", async (_event, _ctx) => {
    if (titleSet || turnCount < 2) return;

    try {
      const api = getApi();
      const sessionName = api.getSessionName();
      if (sessionName && sessionName !== "New Session" && sessionName !== "Untitled") {
        titleSet = true;
        return;
      }
      const title = generateSessionTitle(userMessages);
      if (title) {
        api.setSessionName(title);
        titleSet = true;
        broadcast({ type: "event", event: { type: "session_name", name: title } });
      }
    } catch (e) {
      mwarn("[Mirror] auto-title skipped:", e);
    }
  });

  function generateSessionTitle(messages: string[]): string | null {
    if (messages.length === 0) return null;

    // Find first substantive message (skip greetings and memory instructions)
    const greetings = /^(hey|hello|hi|morning|good morning|howdy|yo|sup)[\s!.:,]*$/i;
    const memoryInstructions = /read (your |the )?(memory|seed|persona|working) files/i;

    let bestMessage = "";
    for (const msg of messages) {
      const cleaned = msg.trim();
      if (greetings.test(cleaned)) continue;
      if (memoryInstructions.test(cleaned)) continue;
      if (cleaned.length < 10) continue;
      bestMessage = cleaned;
      break;
    }

    if (!bestMessage) {
      // Fall back to first message with any content
      bestMessage = messages.find(m => m.trim().length > 0) || "";
    }

    if (!bestMessage) return null;

    // Extract a clean title: first sentence or clause, max ~60 chars
    let title = bestMessage
      .replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, "")
      .replace(/\n.*/s, "") // first line only
      .trim();

    // Take first sentence
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) {
      title = title.substring(0, sentenceEnd);
    }

    // Truncate cleanly
    if (title.length > 60) {
      const spaceIdx = title.lastIndexOf(" ", 57);
      title = title.substring(0, spaceIdx > 20 ? spaceIdx : 57) + "…";
    }

    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title;
  }

  // ═══════════════════════════════════════
  // Build state snapshot for new connections
  // ═══════════════════════════════════════
  async function buildStateSnapshot(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getEntries();
    const model = ctx.model;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const contextUsage = ctx.getContextUsage();

    // Prefer live API (survives session switch); fall back to factory pi
    let thinkingLevel: string | undefined;
    let sessionName: string | undefined;
    try {
      const api = getApi();
      thinkingLevel = api.getThinkingLevel() as string;
      sessionName = api.getSessionName();
      refreshSessionCapture(ctx, api as any);
    } catch {
      try {
        thinkingLevel = pi.getThinkingLevel() as string;
        sessionName = pi.getSessionName();
        refreshSessionCapture(ctx, pi as any);
      } catch { /* ignore */ }
    }

    let commands: CommandDescriptor[] = [];
    let adapterInfo = commandAdapter.info();
    try {
      const listed = await listAllCommands(false);
      commands = listed.commands;
      adapterInfo = listed.adapter;
    } catch { /* ignore */ }

    const sessionCover = await buildSessionCover(ctx);

    let isStreaming = false;
    try { isStreaming = !ctx.isIdle(); } catch { isStreaming = false; }

    return {
      type: "mirror_sync",
      entries,
      model,
      thinkingLevel,
      sessionName,
      sessionFile,
      cwd: sessionCover?.cwd || (ctx as any)?.cwd || process.cwd(),
      isStreaming,
      contextUsage,
      commands,
      sessionCover,
      commandAdapter: adapterInfo,
    };
  }

  // ═══════════════════════════════════════
  // Handle commands from browser clients
  // ═══════════════════════════════════════
  async function handleCommand(ws: WebSocket, command: any) {
    const id = command.id;
    const ctx = latestCtx;
    // Always use the live ExtensionAPI (module-level activePi), never the factory
    // parameter closed over by the first startServer invocation.
    let piApi: ExtensionAPI;
    try {
      piApi = getApi();
    } catch {
      sendTo(ws, {
        type: "response",
        command: command.type,
        success: false,
        error: "Pi API not ready",
        id,
      });
      return;
    }

    const success = (cmd: string, data?: any) => {
      const resp: any = { type: "response", command: cmd, success: true, id };
      if (data !== undefined) resp.data = data;
      return resp;
    };

    const error = (cmd: string, message: string) => {
      return { type: "response", command: cmd, success: false, error: message, id };
    };

    try {
      switch (command.type) {
        // ─── Prompting ───
        // Never call latestCtx.isIdle() without guard — after switchSession the ctx
        // is stale and throws, which previously swallowed prompts (GUI showed, TUI silent).
        case "prompt": {
          refreshSessionCapture(undefined, piApi as any);
          let payload: string | any[] = command.message || "";
          if (command.images?.length) {
            const validMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
            const content: any[] = [{ type: "text", text: command.message || "(see attached image)" }];
            for (const img of command.images) {
              if (!img.data || typeof img.data !== "string") {
                console.error("[mirror-server] Skipping image: missing or invalid data");
                continue;
              }
              const data = img.data.includes(",") ? img.data.split(",")[1] : img.data;
              const mimeType = (validMimes.includes(img.mimeType) ? img.mimeType : "image/png") as
                | "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp";
              content.push({ type: "image" as const, data, mimeType });
            }
            if (content.some((c: any) => c.type === "image")) payload = content;
          }
          const sent = sendPromptToLiveSession(piApi as any, payload, {
            streamingBehavior: command.streamingBehavior || undefined,
          });
          if (sent.ok) sendTo(ws, success("prompt"));
          else sendTo(ws, error("prompt", sent.error || "Failed to deliver prompt to live session"));
          break;
        }

        case "steer": {
          refreshSessionCapture(undefined, piApi as any);
          const sent = sendPromptToLiveSession(piApi as any, command.message, {
            streamingBehavior: "steer",
          });
          if (sent.ok) sendTo(ws, success("steer"));
          else sendTo(ws, error("steer", sent.error || "steer failed"));
          break;
        }

        case "follow_up": {
          refreshSessionCapture(undefined, piApi as any);
          const sent = sendPromptToLiveSession(piApi as any, command.message, {
            streamingBehavior: "followUp",
          });
          if (sent.ok) sendTo(ws, success("follow_up"));
          else sendTo(ws, error("follow_up", sent.error || "follow_up failed"));
          break;
        }

        case "abort": {
          try {
            if (latestCtx) latestCtx.abort();
          } catch {
            try {
              (piApi as any).abort?.();
            } catch { /* ignore */ }
          }
          sendTo(ws, success("abort"));
          break;
        }

        case "new_session": {
          refreshSessionCapture(undefined, piApi as any);
          try {
            const result = await newSessionLikeTui({
              onNewSession: (newCtx) => {
                latestCtx = newCtx;
              },
            });
            if (result.ok || (result as any).recovered) {
              invalidateCommands("new_session");
              gitCache = null;
              await new Promise((r) => setTimeout(r, 200));
              try {
                if (latestCtx) {
                  const snapshot = await buildStateSnapshot(latestCtx);
                  broadcast(snapshot);
                }
              } catch (e) {
                mwarn("[Mirror] post-new snapshot:", e);
              }
              sendTo(ws, success("new_session", {
                sessionFile: result.newSessionFile || latestCtx?.sessionManager?.getSessionFile?.(),
              }));
            } else {
              sendTo(ws, error("new_session", result.error || "New session failed"));
            }
          } catch (e: any) {
            sendTo(ws, error("new_session", e?.message || String(e)));
          }
          break;
        }

        // ─── Commands ───
        case "get_commands": {
          refreshSessionCapture(ctx || undefined, pi as any);
          const listed = await listAllCommands(!!command.refresh);
          sendTo(ws, success("get_commands", {
            commands: listed.commands,
            adapter: listed.adapter,
          }));
          break;
        }

        case "execute_command": {
          const invocation = typeof command.invocation === "string" ? command.invocation.trim() : "";
          if (!invocation.startsWith("/")) {
            sendTo(ws, error("execute_command", "invocation must start with /"));
            break;
          }
          if (invocation.length > 8192) {
            sendTo(ws, error("execute_command", "invocation too long"));
            break;
          }

          // Remote safety: require auth or explicit allow when not loopback client
          const remoteAddr = (ws as any)._socket?.remoteAddress || "";
          const isLocalClient =
            !remoteAddr ||
            remoteAddr === "127.0.0.1" ||
            remoteAddr === "::1" ||
            remoteAddr === "::ffff:127.0.0.1";
          if (!isLocalClient && !authEnabled && !TAU_SETTINGS.allowRemoteCommandExecution) {
            sendTo(ws, error("execute_command", "Remote command execution is disabled. Enable auth or allowRemoteCommandExecution."));
            break;
          }

          // Tau-local actions only under /tau:* — never steal Pi slash names
          if (invocation.startsWith("/tau:")) {
            sendTo(ws, success("execute_command", {
              accepted: true,
              executionMode: "tau-action",
              action: invocation.slice(5),
            }));
            break;
          }

          const cmdName = invocation.split(/\s+/)[0];
          const { commands: reg } = await listAllCommands(false);
          const base = cmdName.toLowerCase();
          const found = reg.find((c) => c.invocation.toLowerCase() === base || `/${c.name}`.toLowerCase() === base);

          // Known terminal-only (no Pi dispatch path)
          if (found?.capability === "terminal-only" || base === "/hotkeys") {
            sendTo(ws, success("execute_command", {
              accepted: false,
              executionMode: "terminal-only",
              error: "This command can only run in the Pi terminal",
            }));
            break;
          }

          // Prefer Pi session.prompt / adapter for all other slash commands
          // (including /settings, /model, /thinking, /compact when Pi owns them)
          refreshSessionCapture(ctx || undefined, pi as any);
          const result = await commandAdapter.execute(invocation, {
            streamingBehavior: command.streamingBehavior,
          });
          if (result.accepted) {
            sendTo(ws, success("execute_command", result));
            break;
          }

          // If not in registry and adapter failed, still don't open Tau UI
          if (!found) {
            // Last attempt already failed — report clearly
            sendTo(ws, {
              type: "response",
              command: "execute_command",
              success: false,
              id,
              error: result.error || `Unknown or unexecutable command: ${cmdName}`,
              data: result,
            });
            break;
          }

          if (found.capability === "insert-only" || found.capability === "unavailable") {
            sendTo(ws, success("execute_command", {
              accepted: false,
              executionMode: found.capability,
              error: result.error || "Current Pi version cannot dispatch this command from Tau",
            }));
            break;
          }

          sendTo(ws, {
            type: "response",
            command: "execute_command",
            success: false,
            id,
            error: result.error || "Execution failed",
            data: result,
          });
          break;
        }

        case "get_session_cover": {
          const cover = await buildSessionCover(ctx);
          sendTo(ws, success("get_session_cover", cover));
          break;
        }

        case "shutdown": {
          // Intentionally never process.exit — only acknowledge
          mlog("[Mirror] WS shutdown received — ignored");
          sendTo(ws, success("shutdown", {
            ignored: true,
            exitProcess: false,
            buildId: TAU_BUILD_ID,
          }));
          break;
        }

        case "switch_session": {
          // Resume like TUI /resume pick — absolute session path, same-cwd only
          const sessionFile = typeof command.sessionFile === "string" ? command.sessionFile : "";
          if (!sessionFile) {
            sendTo(ws, error("switch_session", "sessionFile required"));
            break;
          }
          // Read idle/cwd from latestCtx carefully — the WS `ctx` may already be stale mid-handler
          let busy = false;
          let liveCwd = process.cwd();
          try {
            busy = !!(latestCtx && !latestCtx.isIdle());
            liveCwd = (latestCtx as any)?.cwd || process.cwd();
          } catch { /* ignore */ }
          if (busy) {
            sendTo(ws, error("switch_session", "Agent is busy — finish the current turn first"));
            break;
          }
          refreshSessionCapture(undefined, pi as any);
          const result = await resumeSessionLikeTui(sessionFile, {
            requireSameCwd: true,
            liveCwd,
            onNewSession: (newCtx) => { latestCtx = newCtx; },
          });
          if (result.ok || result.recovered) {
            invalidateCommands("session_switch");
            gitCache = null;
            // Snapshot comes from session_start; do not use pre-switch ctx
            sendTo(ws, success("switch_session", {
              sessionFile: result.newSessionFile || sessionFile,
              switched: true,
              recovered: !!result.recovered,
              mode: "resume-like-tui",
            }));
          } else if (/stale/i.test(result.error || "")) {
            // TUI already switched
            sendTo(ws, success("switch_session", {
              sessionFile,
              switched: true,
              recovered: true,
              mode: "resume-like-tui",
            }));
          } else {
            sendTo(ws, {
              type: "response",
              command: "switch_session",
              success: false,
              id,
              error: result.error || "Resume failed",
              data: result,
            });
          }
          break;
        }

        // ─── State ───
        case "get_state": {
          if (!ctx) {
            sendTo(ws, error("get_state", "No context available"));
            break;
          }
          try {
            const model = ctx.model;
            let isStreaming = false;
            try { isStreaming = !ctx.isIdle(); } catch { isStreaming = false; }
            const state = {
              model,
              thinkingLevel: piApi.getThinkingLevel(),
              isStreaming,
              sessionFile: ctx.sessionManager.getSessionFile(),
              sessionName: piApi.getSessionName(),
              autoCompactionEnabled: true,
            };
            sendTo(ws, success("get_state", state));
          } catch (e: any) {
            sendTo(ws, error("get_state", e?.message || String(e)));
          }
          break;
        }

        case "get_messages": {
          if (!ctx) {
            sendTo(ws, error("get_messages", "No context available"));
            break;
          }
          const entries = ctx.sessionManager.getEntries();
          sendTo(ws, success("get_messages", { entries }));
          break;
        }

        // ─── Model ───
        case "get_available_models": {
          if (!ctx) {
            sendTo(ws, error("get_available_models", "No context available"));
            break;
          }
          const models = await ctx.modelRegistry.getAvailable();
          sendTo(ws, success("get_available_models", { models }));
          break;
        }

        case "set_model": {
          if (!ctx) {
            sendTo(ws, error("set_model", "No context available"));
            break;
          }
          try {
            const models = await ctx.modelRegistry.getAvailable();
            const model = models.find(
              (m: any) => m.provider === command.provider && m.id === command.modelId
            );
            if (!model) {
              sendTo(ws, error("set_model", `Model not found: ${command.provider}/${command.modelId}`));
              break;
            }
            const ok = await piApi.setModel(model);
            if (!ok) {
              sendTo(ws, error("set_model", "No API key for this model"));
              break;
            }
            sendTo(ws, success("set_model", model));
          } catch (e: any) {
            sendTo(ws, error("set_model", e?.message || String(e)));
          }
          break;
        }

        case "cycle_model": {
          if (!ctx) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          try {
            const availModels = await ctx.modelRegistry.getAvailable();
            const currentModel = ctx.model;
            if (!currentModel || availModels.length <= 1) {
              sendTo(ws, success("cycle_model", null));
              break;
            }
            const idx = availModels.findIndex(
              (m: any) => m.provider === currentModel.provider && m.id === currentModel.id
            );
            const nextModel = availModels[(idx + 1) % availModels.length];
            await piApi.setModel(nextModel);
            sendTo(ws, success("cycle_model", {
              model: nextModel,
              thinkingLevel: piApi.getThinkingLevel(),
            }));
          } catch (e: any) {
            sendTo(ws, error("cycle_model", e?.message || String(e)));
          }
          break;
        }

        // ─── Thinking ───
        case "cycle_thinking_level": {
          try {
            const levels = ["off", "minimal", "low", "medium", "high"];
            const current = piApi.getThinkingLevel();
            const idx = levels.indexOf(current as string);
            const next = levels[(idx + 1) % levels.length];
            piApi.setThinkingLevel(next as any);
            const actual = piApi.getThinkingLevel();
            // Keep other tabs / header in sync
            broadcast({
              type: "event",
              event: { type: "thinking_level_changed", level: actual },
            });
            sendTo(ws, success("cycle_thinking_level", { level: actual }));
          } catch (e: any) {
            const msg = e?.message || String(e);
            mwarn("[Mirror] cycle_thinking_level failed:", msg);
            sendTo(ws, error("cycle_thinking_level", msg));
          }
          break;
        }

        case "set_thinking_level": {
          try {
            piApi.setThinkingLevel(command.level);
            const actual = piApi.getThinkingLevel();
            broadcast({
              type: "event",
              event: { type: "thinking_level_changed", level: actual },
            });
            sendTo(ws, success("set_thinking_level", { level: actual }));
          } catch (e: any) {
            sendTo(ws, error("set_thinking_level", e?.message || String(e)));
          }
          break;
        }

        // ─── Session ───
        case "get_session_stats": {
          if (!ctx) {
            sendTo(ws, error("get_session_stats", "No context available"));
            break;
          }
          const usage = ctx.getContextUsage();
          const entries = ctx.sessionManager.getEntries();
          let userMessages = 0, assistantMessages = 0, toolCalls = 0;
          for (const e of entries) {
            if (e.type === "message") {
              if (e.message?.role === "user") userMessages++;
              else if (e.message?.role === "assistant") assistantMessages++;
              else if (e.message?.role === "toolResult") toolCalls++;
            }
          }
          sendTo(ws, success("get_session_stats", {
            sessionFile: ctx.sessionManager.getSessionFile(),
            userMessages,
            assistantMessages,
            toolCalls,
            totalMessages: entries.length,
            tokens: usage ? { input: usage.tokens, total: usage.tokens } : null,
          }));
          break;
        }

        case "set_session_name": {
          const name = command.name?.trim();
          if (!name) {
            sendTo(ws, error("set_session_name", "Name cannot be empty"));
            break;
          }
          try {
            piApi.setSessionName(name);
            sendTo(ws, success("set_session_name"));
          } catch (e: any) {
            sendTo(ws, error("set_session_name", e?.message || String(e)));
          }
          break;
        }

        case "set_auto_compaction": {
          // Extension can't easily toggle auto-compaction
          // Just acknowledge
          sendTo(ws, success("set_auto_compaction"));
          break;
        }

        case "compact": {
          if (ctx) {
            // Broadcast compaction start to all clients
            broadcast({ type: "auto_compaction_start" });
            ctx.compact({
              customInstructions: command.customInstructions,
              onComplete: (result: any) => {
                broadcast({ type: "auto_compaction_end", summary: result?.summary });
              },
              onError: (err: any) => {
                broadcast({ type: "auto_compaction_end", summary: `Error: ${err.message}` });
              },
            });
          }
          sendTo(ws, success("compact"));
          break;
        }

        case "export_html": {
          if (!ctx) {
            sendTo(ws, error("export_html", "No context available"));
            break;
          }
          try {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) throw new Error("No session file to export");
            const { execSync } = require("node:child_process");
            const args = command.outputPath
              ? `"${sessionFile}" "${command.outputPath}"`
              : `"${sessionFile}"`;
            const output = execSync(`pi --export ${args}`, { cwd: process.cwd(), timeout: 30000, encoding: "utf-8" });
            // pi prints the output path
            const result = output.trim().split("\n").pop() || sessionFile.replace(".jsonl", ".html");
            sendTo(ws, success("export_html", { path: result }));
          } catch (e: any) {
            sendTo(ws, error("export_html", e.message));
          }
          break;
        }

        // ─── Commands & Files ───
        // ─── Sync ───
        case "mirror_sync_request": {
          if (ctx) {
            const snapshot = await buildStateSnapshot(ctx);
            sendTo(ws, snapshot);
          } else {
            sendTo(ws, { type: "mirror_sync", entries: [], model: null });
          }
          break;
        }

        // ─── Auth ───
        case "get_auth": {
          sendTo(ws, success("get_auth", { configured: AUTH_CONFIGURED, enabled: authEnabled }));
          break;
        }

        case "set_auth": {
          if (!AUTH_CONFIGURED) {
            sendTo(ws, error("set_auth", "No credentials configured. Set tau.user and tau.pass in settings.json"));
            break;
          }
          authEnabled = !!command.enabled;
          saveTauSetting("authEnabled", authEnabled);
          broadcast({ type: "event", event: { type: "auth_changed", enabled: authEnabled } });
          sendTo(ws, success("set_auth", { enabled: authEnabled }));
          break;
        }

        default: {
          sendTo(ws, error(command.type, `Unknown command: ${command.type}`));
        }
      }
    } catch (e: any) {
      sendTo(ws, error(command.type || "unknown", e.message || String(e)));
    }
  }

  // ═══════════════════════════════════════
  // Static file server
  // ═══════════════════════════════════════
  function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
    let urlPath = req.url || "/";

    // Auth gate — exempt health + shutdown (beacon has no Basic Auth headers)
    const barePath = (urlPath.split("?")[0] || "/");
    if (
      authEnabled &&
      barePath !== "/api/health" &&
      barePath !== "/api/shutdown" &&
      !checkBasicAuth(req)
    ) {
      sendAuthRequired(res);
      return;
    }

    // Handle API routes
    if (urlPath.startsWith("/api/")) {
      handleApiRoute(req, res, urlPath);
      return;
    }

    // Strip query params
    urlPath = urlPath.split("?")[0];

    // Default to index.html
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.join(STATIC_DIR, urlPath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Check file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ═══════════════════════════════════════
  // API routes (sessions list, etc.)
  // ═══════════════════════════════════════
  function handleApiRoute(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
    // Path without query string — used by all /api/* matchers below
    const barePath = (urlPath.split("?")[0] || "/");

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (urlPath === "/api/qr") {
      if (!mirrorUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Server not ready" }));
        return;
      }
      const qrPromises = [QRCode.toDataURL(mirrorUrl, { width: 256, margin: 2 })];
      if (tailscaleUrl) qrPromises.push(QRCode.toDataURL(tailscaleUrl, { width: 256, margin: 2 }));
      Promise.all(qrPromises).then((dataUrls: string[]) => {
        const tsSection = tailscaleUrl && dataUrls[1]
          ? `<p style="margin-top:24px;color:rgba(255,255,255,0.3);font-size:11px">TAILSCALE</p><img src="${dataUrls[1]}" width="256" height="256" alt="Tailscale QR"><a href="${tailscaleUrl}">${tailscaleUrl}</a>`
          : "";
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width"><title>Tau — Connect</title>
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#131316;color:#fff;font-family:-apple-system,sans-serif}
img{border-radius:12px}a{color:#b87a5c;font-size:18px;margin-top:16px}p{color:rgba(255,255,255,0.5);font-size:13px;margin-top:8px}</style>
</head><body><p style="color:rgba(255,255,255,0.3);font-size:11px">LAN</p><img src="${dataUrls[0]}" width="256" height="256" alt="QR Code"><a href="${mirrorUrl}">${mirrorUrl}</a>${tsSection}<p style="margin-top:16px">Scan to open Tau on your phone</p></body></html>`);
      }).catch((e: any) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    if (urlPath === "/api/health") {
      const liveCwd =
        (latestCtx as any)?.cwd ||
        process.cwd();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        mode: "mirror",
        mirrorUrl,
        tailscaleUrl: tailscaleUrl || undefined,
        platform: process.platform,
        cwd: liveCwd,
        sessionFile: (latestCtx as any)?.sessionManager?.getSessionFile?.() || undefined,
      }));
      return;
    }

    // File preview — serve image bytes for thumbnail display in the browser
    if ((urlPath === "/api/file/preview" || urlPath.startsWith("/api/file/preview?")) && req.method === "GET") {
      const previewUrl = new URL(`http://localhost${req.url}`);
      const filePath = previewUrl.searchParams.get("path");
      if (!filePath) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "path required" }));
        return;
      }
      const IMAGE_PREVIEW_MIMES: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
      };
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mimeType = IMAGE_PREVIEW_MIMES[ext];
      if (!mimeType) {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a previewable image" }));
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new Error("Not a file");
        res.writeHead(200, { "Content-Type": mimeType, "Cache-Control": "max-age=60" });
        fs.createReadStream(filePath).pipe(res);
      } catch (err: any) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (urlPath === "/api/instances") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ instances: getRunningInstances() }));
      return;
    }

    if (urlPath === "/api/projects" && req.method === "GET") {
      serveProjectsList(res);
      return;
    }

    if (urlPath === "/api/projects/launch" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { path: projectPath } = JSON.parse(body);
          if (!projectPath || typeof projectPath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "path required" }));
            return;
          }
          // Resolve ~ in path
          const resolved = projectPath.startsWith("~")
            ? path.join(process.env.HOME || "", projectPath.slice(1))
            : projectPath;
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Directory not found" }));
            return;
          }
          const { execSync } = require("node:child_process");
          const escaped = resolved.replace(/'/g, "'\\''");
          execSync(`osascript -e 'tell app "iTerm2" to create window with default profile command "cd '"'"'${escaped}'"'"' && pi"'`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (urlPath === "/api/sessions" && req.method === "GET") {
      serveSessionsList(res);
      return;
    }

    // Full-text search across sessions
    if (urlPath.startsWith("/api/search") && req.method === "GET") {
      const searchUrl = new URL(`http://localhost${req.url}`);
      const q = searchUrl.searchParams.get("q") || "";
      serveSearch(res, q);
      return;
    }

    // File browser: list directory
    if (urlPath === "/api/files" || urlPath.startsWith("/api/files?")) {
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      try {
        const filesUrl = new URL(`http://localhost${req.url}`);
        const explicitPath = filesUrl.searchParams.get("path");
        let dirPath = explicitPath || process.cwd();
        if (!explicitPath && latestCtx) {
          try {
            const entries = latestCtx.sessionManager.getEntries();
            const sessionEntry = entries.find((e: any) => e.type === "session");
            if (sessionEntry?.cwd) dirPath = sessionEntry.cwd;
          } catch {}
        }
        serveFileList(res, dirPath);
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // File browser: open file natively
    if (urlPath === "/api/open" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { filePath: fp } = JSON.parse(body);
          if (!fp || typeof fp !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          const { execFile } = await import("node:child_process");
          if (process.platform === "win32") {
            const { exec } = await import("node:child_process");
            const safe = fp.replace(/'/g, "''").replace(/"/g, '');
            exec(`powershell -NoProfile -WindowStyle Hidden -Command "& { $wsh = New-Object -ComObject WScript.Shell; $wsh.Run('explorer \\"${safe}\\"', 1, $false) }"`, (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          } else if (process.platform === "darwin") {
            execFile("open", [fp], (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          } else {
            execFile("xdg-open", [fp], (err) => {
              if (err) console.error("[Mirror] open failed:", err.message);
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Session history by absolute file path (preferred — avoids dirName encoding issues)
    // GET /api/sessions/by-path?path=C:\Users\...\.pi\agent\sessions\...\file.jsonl
    if (barePath === "/api/sessions/by-path" && req.method === "GET") {
      try {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        let filePath = u.searchParams.get("path") || "";
        try { filePath = decodeURIComponent(filePath); } catch { /* keep */ }
        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "path required" }));
          return;
        }
        const resolved = path.resolve(filePath);
        const sessionsRoot = path.resolve(SESSIONS_DIR);
        // Must live under sessions dir (prevent path traversal)
        const rel = path.relative(sessionsRoot, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Path outside sessions directory" }));
          return;
        }
        serveSessionFileAbsolute(res, resolved);
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e?.message || String(e) }));
      }
      return;
    }

    // Session file endpoint: /api/sessions/:dirName/:file
    const sessionMatch = barePath.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      let dirName = sessionMatch[1];
      let file = sessionMatch[2];
      try { dirName = decodeURIComponent(dirName); } catch { /* keep raw */ }
      try { file = decodeURIComponent(file); } catch { /* keep raw */ }
      serveSessionFile(res, dirName, file);
      return;
    }

    // Browser tab close beacon — ALWAYS no-op for process lifetime.
    // (Leftover tabs + auto-open were killing Pi on startup via process.exit.)
    if (barePath === "/api/shutdown") {
      if (req.method === "POST" || req.method === "GET") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          let reason = "web_ui_closed";
          try {
            if (body) {
              const parsed = JSON.parse(body);
              if (parsed?.reason) reason = String(parsed.reason);
            }
          } catch { /* ignore */ }
          mlog(`[Mirror] /api/shutdown ignored (reason=${reason})`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            ignored: true,
            exitProcess: false,
            reason,
            buildId: TAU_BUILD_ID,
          }));
        });
        return;
      }
    }

    // POST /api/sessions/new — same as TUI /new
    if (barePath === "/api/sessions/new" && req.method === "POST") {
      (async () => {
        try {
          if (latestCtx && !latestCtx.isIdle()) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Agent is busy — finish the current turn first" }));
            return;
          }
          refreshSessionCapture(undefined, pi as any);
          const result = await newSessionLikeTui({
            onNewSession: (newCtx) => { latestCtx = newCtx; },
          });
          await new Promise((r) => setTimeout(r, 250));
          if (!result.ok && !(result as any).recovered) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error || "New session failed" }));
            return;
          }
          invalidateCommands("new_session");
          gitCache = null;
          try {
            if (latestCtx) {
              const liveFile = latestCtx.sessionManager?.getSessionFile?.() || result.newSessionFile || "";
              updateInstanceSession(liveFile, (latestCtx as any).cwd || process.cwd());
              const snapshot = await buildStateSnapshot(latestCtx);
              broadcast(snapshot);
            }
          } catch (e) {
            mwarn("[Mirror] post-new snapshot:", e);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            sessionFile: latestCtx?.sessionManager?.getSessionFile?.() || result.newSessionFile,
            cwd: (latestCtx as any)?.cwd || process.cwd(),
          }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e?.message || String(e) }));
        }
      })();
      return;
    }

    // RPC proxy — handle via WebSocket command handler
    if (urlPath === "/api/rpc" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const command = JSON.parse(body);
          // Create a fake WebSocket-like object to capture the response
          const responsePromise = new Promise<any>((resolve) => {
            const fakeWs = {
              readyState: WebSocket.OPEN,
              send: (data: string) => resolve(JSON.parse(data)),
            } as any;
            handleCommand(fakeWs, command);
          });
          const response = await responsePromise;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Resume like TUI /resume after picking a session (same-cwd only)
    if (
      (urlPath === "/api/sessions/switch" || urlPath === "/api/sessions/resume") &&
      req.method === "POST"
    ) {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { sessionFile } = JSON.parse(body || "{}");
          if (!sessionFile || typeof sessionFile !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "sessionFile required" }));
            return;
          }
          if (latestCtx && !latestCtx.isIdle()) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Agent is busy — finish the current turn first" }));
            return;
          }
          const preCwd = (latestCtx as any)?.cwd || process.cwd();
          // Snapshot pre-switch file only (string) — do not hold latestCtx across await
          const preFile = (() => {
            try {
              return latestCtx?.sessionManager?.getSessionFile?.() || "";
            } catch {
              return "";
            }
          })();

          refreshSessionCapture(latestCtx || undefined, pi as any);
          try { pi.getCommands?.(); } catch { /* ignore */ }

          let result = await resumeSessionLikeTui(sessionFile, {
            requireSameCwd: true,
            liveCwd: preCwd,
            onNewSession: (newCtx) => {
              // ONLY place it is safe to assign post-switch context
              latestCtx = newCtx;
            },
          });

          // Give session_start a moment to also update latestCtx + broadcast
          await new Promise((r) => setTimeout(r, 300));

          // Soft success if we recovered from stale-ctx or live file moved
          let liveNow = "";
          try {
            liveNow = latestCtx?.sessionManager?.getSessionFile?.() || result.newSessionFile || "";
          } catch {
            liveNow = result.newSessionFile || "";
          }
          if (!result.ok && liveNow) {
            try {
              if (path.resolve(liveNow).toLowerCase() === path.resolve(sessionFile).toLowerCase()) {
                mlog("[Mirror] Resume soft-success (live session matches)");
                result = { ...result, ok: true, recovered: true };
              }
            } catch { /* ignore */ }
          }
          // Also soft-success if TUI moved off preFile (switch happened)
          if (!result.ok && liveNow && preFile && path.resolve(liveNow).toLowerCase() !== path.resolve(preFile).toLowerCase()) {
            mlog("[Mirror] Resume soft-success (live session file changed)");
            result = { ...result, ok: true, recovered: true };
          }

          if (!result.ok) {
            res.writeHead(result.cancelled ? 409 : 400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: result.error || "Resume failed",
              cancelled: result.cancelled,
              readonly: true,
              hint: /stale/i.test(result.error || "")
                ? "Session likely resumed in TUI; refresh Tau. Run /tau-switch once if sidebar resume stays broken."
                : result.error?.includes("another directory")
                  ? "Other-directory sessions are history-only in Tau. Use /resume in the Pi terminal for cross-cwd."
                  : "Run /tau-switch once in the terminal to arm the hook, then retry.",
            }));
            return;
          }

          invalidateCommands("session_switch");
          gitCache = null;

          // Prefer snapshot already broadcast by session_start. Optionally re-broadcast
          // using latestCtx only if it was updated via withSession / session_start.
          try {
            if (latestCtx) {
              const liveFile =
                (() => {
                  try {
                    return latestCtx.sessionManager?.getSessionFile?.() || sessionFile;
                  } catch {
                    return sessionFile;
                  }
                })();
              updateInstanceSession(liveFile, (latestCtx as any).cwd || process.cwd());
              // session_start usually already broadcast; skip if still mid-rebind
              try {
                const snapshot = await buildStateSnapshot(latestCtx);
                broadcast(snapshot);
              } catch (e) {
                mwarn("[Mirror] post-resume snapshot skipped:", e);
              }
            }
          } catch (e) {
            mwarn("[Mirror] post-resume update skipped:", e);
          }

          let outFile = sessionFile;
          let outCwd = preCwd;
          try {
            outFile = latestCtx?.sessionManager?.getSessionFile?.() || result.newSessionFile || sessionFile;
            outCwd = (latestCtx as any)?.cwd || preCwd;
          } catch { /* use defaults */ }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            mode: "resume-like-tui",
            recovered: !!result.recovered,
            sessionFile: outFile,
            cwd: outCwd,
          }));
        } catch (e: any) {
          console.error("[Mirror] /api/sessions/resume error:", e);
          // If error is stale-ctx, TUI likely already switched — tell client to sync
          const msg = e?.message || String(e);
          if (/stale after session replacement|ctx is stale/i.test(msg)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              success: true,
              recovered: true,
              mode: "resume-like-tui",
              sessionFile,
              message: "TUI resumed; GUI should mirror_sync",
            }));
            return;
          }
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
      });
      return;
    }

    // Session delete
    if (urlPath === "/api/sessions/delete" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { filePath } = JSON.parse(body);
          if (!filePath || typeof filePath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          if (!fs.existsSync(filePath)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          fs.unlinkSync(filePath);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Memoryd check
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ═══════════════════════════════════════
  // Sessions list endpoint
  // ═══════════════════════════════════════
  function getTmuxSessionFiles(): Set<string> {
    if (process.platform === "win32") return new Set();
    try {
      const { execSync } = require("node:child_process");
      // Get tmux pane PIDs
      const paneOutput = execSync("tmux list-panes -a -F '#{pane_pid}' 2>/dev/null", { encoding: "utf8" });
      const tmuxFiles = new Set<string>();

      for (const shellPid of paneOutput.trim().split("\n").filter(Boolean)) {
        try {
          // Find Pi (node) processes that are children of tmux shells
          const children = execSync(`pgrep -P ${shellPid} 2>/dev/null`, { encoding: "utf8" });
          for (const pid of children.trim().split("\n").filter(Boolean)) {
            // Check what .jsonl files this process has open
            const lsofOut = execSync(`lsof -p ${pid} 2>/dev/null | grep '\\.jsonl'`, { encoding: "utf8" });
            for (const line of lsofOut.trim().split("\n").filter(Boolean)) {
              const match = line.match(/\/.+\.jsonl$/);
              if (match) tmuxFiles.add(match[0]);
            }
          }
        } catch { /* no match */ }
      }
      return tmuxFiles;
    } catch {
      return new Set();
    }
  }

  function serveProjectsList(res: http.ServerResponse) {
    const projectsDir = TAU_SETTINGS.projectsDir;
    if (!projectsDir) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [] }));
      return;
    }

    const resolved = projectsDir.startsWith("~")
      ? path.join(process.env.HOME || "", projectsDir.slice(1))
      : projectsDir;

    if (!fs.existsSync(resolved)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [], error: "Directory not found" }));
      return;
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const instances = getRunningInstances();

      // Build session count + recency map from session history
      const sessionInfo = new Map<string, { count: number; lastActive: number }>();
      if (fs.existsSync(SESSIONS_DIR)) {
        for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
          // Check if this session dir maps to a subdirectory of the projects folder
          if (!decodedPath.startsWith(resolved + "/") && !decodedPath.startsWith(resolved)) continue;

          const sessionDir = path.join(SESSIONS_DIR, dir.name);
          const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
          let lastMtime = 0;
          for (const f of files) {
            try {
              const stat = fs.statSync(path.join(sessionDir, f));
              if (stat.mtimeMs > lastMtime) lastMtime = stat.mtimeMs;
            } catch {}
          }
          sessionInfo.set(decodedPath, { count: files.length, lastActive: lastMtime });
        }
      }

      const projects = entries
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => {
          const fullPath = path.join(resolved, e.name);
          const info = sessionInfo.get(fullPath) || { count: 0, lastActive: 0 };
          const isActive = instances.some(i => i.cwd === fullPath);
          return {
            name: e.name,
            path: fullPath,
            sessionCount: info.count,
            lastActive: info.lastActive || null,
            active: isActive,
          };
        });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  async function serveSessionsList(res: http.ServerResponse) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ projects: [] }));
        return;
      }

      const tmuxFiles = getTmuxSessionFiles();
      const readline = await import("node:readline");
      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
      const projects: any[] = [];

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");

        const sessions: any[] = [];

        for (const file of files) {
          try {
            const filePath = path.join(projectDir, file);
            const parsed = await parseSessionFile(filePath, readline);
            if (parsed) {
              const stat = fs.statSync(filePath);
              const isTmux = tmuxFiles.has(filePath);
              sessions.push({ ...parsed, file, filePath, mtime: stat.mtimeMs, ...(isTmux && { tmux: true }) });
            }
          } catch { /* skip */ }
        }

        sessions.sort((a, b) => b.mtime - a.mtime);

        if (sessions.length > 0) {
          projects.push({ path: decodedPath, dirName: dir.name, sessions });
        }
      }

      projects.sort((a, b) => {
        const aTime = a.sessions[0]?.mtime || 0;
        const bTime = b.sessions[0]?.mtime || 0;
        return bTime - aTime;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ═══════════════════════════════════════
  // Session file endpoint
  // ═══════════════════════════════════════
  function serveSessionFileAbsolute(res: http.ServerResponse, filePath: string) {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found", path: filePath }));
      return;
    }

    const entries: any[] = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    let buffer = "";

    stream.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          try { entries.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        try { entries.push(JSON.parse(buffer)); } catch { /* skip */ }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries, filePath, count: entries.length }));
    });

    stream.on("error", (e: Error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
  }

  function serveSessionFile(res: http.ServerResponse, dirName: string, file: string) {
    // dirName may contain leading dashes like --C--Users-14868--
    const filePath = path.join(SESSIONS_DIR, dirName, file);
    serveSessionFileAbsolute(res, filePath);
  }

  // ═══════════════════════════════════════
  // Parse session file header
  // ═══════════════════════════════════════
  async function parseSessionFile(filePath: string, readline: any) {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let header: any = null;
    let firstMessage: string | null = null;
    let sessionName: string | null = null;
    let userMessageCount = 0;
    let lineCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;

      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") header = entry;
        else if (entry.type === "session_info" && entry.name) sessionName = entry.name;
        else if (entry.type === "message" && entry.message?.role === "user") {
          userMessageCount++;
          if (!firstMessage) {
            const content = entry.message.content;
            if (typeof content === "string") firstMessage = content.substring(0, 120);
            else if (Array.isArray(content)) {
              const tb = content.find((b: any) => b.type === "text");
              if (tb) firstMessage = tb.text.substring(0, 120);
            }
          }
        }
      } catch { /* skip */ }

      if (lineCount > 50 && firstMessage) break;
    }

    rl.close();
    stream.destroy();

    if (!header?.id) return null;
    if (userMessageCount <= 1 && lineCount <= 8) return null; // pipe mode

    return {
      id: header.id,
      timestamp: header.timestamp || "",
      name: sessionName,
      firstMessage,
      cwd: header.cwd || null,
    };
  }

  // ═══════════════════════════════════════
  // File browser
  // ═══════════════════════════════════════

  const IGNORED_NAMES = new Set([
    "node_modules", ".git", "__pycache__", ".DS_Store", ".Trash",
    ".next", ".nuxt", "dist", "build", ".cache", ".turbo",
    "venv", ".venv", "env", ".env.local",
    ".pi", "coverage", ".nyc_output", ".parcel-cache",
  ]);

  function serveFileList(res: http.ServerResponse, dirPath: string) {
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a directory" }));
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items: any[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (IGNORED_NAMES.has(entry.name)) continue;

        try {
          const fullPath = path.join(dirPath, entry.name);
          const stat = fs.statSync(fullPath);

          items.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: entry.isDirectory() ? null : stat.size,
            mtime: stat.mtimeMs,
          });
        } catch { /* skip inaccessible */ }
      }

      // Directories first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: dirPath, items }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════
  // Full-text search
  // ═══════════════════════════════════════

  async function serveSearch(res: http.ServerResponse, query: string) {
    try {
      if (!query || query.length < 2) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const q = query.toLowerCase();
      const readline = await import("node:readline");
      const results: any[] = [];
      const MAX_RESULTS = 30;

      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        if (results.length >= MAX_RESULTS) break;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));

        for (const file of files) {
          if (results.length >= MAX_RESULTS) break;

          try {
            const filePath = path.join(projectDir, file);
            const stream = fs.createReadStream(filePath, { encoding: "utf8" });
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

            let sessionId = "";
            let sessionName = "";
            let sessionTimestamp = "";
            let firstMessage = "";
            const matches: any[] = [];

            for await (const line of rl) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);

                if (entry.type === "session") {
                  sessionId = entry.id;
                  sessionTimestamp = entry.timestamp || "";
                }
                if (entry.type === "session_info" && entry.name) {
                  sessionName = entry.name;
                }
                if (entry.type === "message") {
                  const content = entry.message?.content;
                  let text = "";
                  if (typeof content === "string") text = content;
                  else if (Array.isArray(content)) {
                    text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
                  }

                  if (!firstMessage && entry.message?.role === "user" && text) {
                    firstMessage = text.substring(0, 120);
                  }

                  if (text && text.toLowerCase().includes(q)) {
                    // Extract a snippet around the match
                    const idx = text.toLowerCase().indexOf(q);
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(text.length, idx + q.length + 60);
                    const snippet = (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length ? "…" : "");

                    matches.push({
                      role: entry.message?.role || "unknown",
                      snippet: snippet.replace(/\n/g, " "),
                    });

                    if (matches.length >= 3) break; // max 3 matches per session
                  }
                }
              } catch { /* skip line */ }
            }

            rl.close();
            stream.destroy();

            if (matches.length > 0) {
              results.push({
                filePath,
                project: decodedPath,
                sessionId,
                sessionName,
                sessionTimestamp,
                firstMessage,
                matches,
              });
            }
          } catch { /* skip file */ }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════
  // Start server function (reusable)
  // ═══════════════════════════════════════
  function startServer(ctx: ExtensionContext) {
    if (server) return; // Already running

    // Clean up zombie instances from killed tmux panes etc.
    cleanupZombieInstances();

    server = http.createServer(serveStaticFile);
    wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      if (authEnabled && !checkBasicAuth(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"Tau\"\r\n\r\n");
        socket.destroy();
        return;
      }
      if (request.url === "/ws") {
        wss!.handleUpgrade(request, socket, head, (ws) => {
          wss!.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on("connection", (ws) => {
      mlog("[Mirror] Browser client connected");
      clients.add(ws);
      (ws as any).isAlive = true;

      ws.on("pong", () => {
        (ws as any).isAlive = true;
      });

      // Send initial state
      sendTo(ws, { type: "state", isStreaming: false, mode: "mirror" });

      // Immediately send state snapshot
      if (latestCtx) {
        buildStateSnapshot(latestCtx).then((snapshot) => {
          sendTo(ws, snapshot);
        });
      }

      ws.on("message", (data) => {
        try {
          const command = JSON.parse(data.toString());
          handleCommand(ws, command);
        } catch (e) {
          console.error("[Mirror] Failed to parse client message:", e);
        }
      });

      ws.on("close", () => {
        mlog("[Mirror] Browser client disconnected");
        clients.delete(ws);
      });

      ws.on("error", (e) => {
        console.error("[Mirror] Client error:", e);
        clients.delete(ws);
      });
    });

    // Heartbeat keeps mobile/Tailscale sessions alive and removes stale clients.
    heartbeatTimer = setInterval(() => {
      for (const client of clients) {
        if (client.readyState !== WebSocket.OPEN) {
          clients.delete(client);
          continue;
        }

        if (!(client as any).isAlive) {
          try { client.terminate(); } catch {}
          clients.delete(client);
          continue;
        }

        (client as any).isAlive = false;
        try { client.ping(); } catch {}
      }
    }, 20000);

    const tryListen = (port: number, maxAttempts = 10) => {
      server!.listen(port, HOST, () => {
        onListening(port);
      });
      server!.once("error", (err: any) => {
        if (err.code === "EADDRINUSE" && port < PORT + maxAttempts) {
          // Check if a stale Tau instance owns this port and kill it
          const instances = getRunningInstances();
          const stale = instances.find(i => i.port === port && i.pid !== process.pid);
          if (stale && isZombieProcess(stale.pid)) {
            mlog(`[Mirror] Port ${port} in use by stale Tau instance (PID ${stale.pid}), killing...`);
            try { process.kill(stale.pid, "SIGTERM"); } catch {}
            // Wait briefly then retry the same port
            setTimeout(() => {
              server!.removeAllListeners("error");
              tryListen(port, maxAttempts);
            }, 500);
            return;
          }
          mlog(`[Mirror] Port ${port} in use, trying ${port + 1}...`);
          server!.removeAllListeners("error");
          tryListen(port + 1, maxAttempts);
        } else {
          console.error(`[Mirror] Failed to start server:`, err.message);
        }
      });
    };

    const onListening = (port: number) => {
      serverStartedAt = Date.now();
      const isLoopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

      let localIp = "localhost";
      let tailscaleIp = "";

      if (!isLoopback) {
        // Get local IP for display — prefer en0/en1 (WiFi/Ethernet) over bridges/VPNs
        const nets = require("node:os").networkInterfaces();
        let fallbackIp = "";
        const preferred = ["en0", "en1"];
        for (const name of preferred) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal) {
              localIp = net.address;
              break;
            }
          }
          if (localIp !== "localhost") break;
        }
        if (localIp === "localhost") {
          for (const name of Object.keys(nets)) {
            if (name.startsWith("bridge") || name.startsWith("utun") || name.startsWith("lo")) continue;
            for (const net of nets[name] || []) {
              if (net.family === "IPv4" && !net.internal && (net.address.startsWith("192.168.") || net.address.startsWith("10."))) {
                localIp = net.address;
                break;
              }
            }
            if (localIp !== "localhost") break;
          }
        }
        if (localIp === "localhost" && fallbackIp) localIp = fallbackIp;

        // Detect Tailscale IP (100.x.x.x CGNAT range)
        for (const name of Object.keys(nets)) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal && net.address.startsWith("100.")) {
              tailscaleIp = net.address;
              break;
            }
          }
          if (tailscaleIp) break;
        }
      }

      mirrorUrl = `http://${localIp}:${port}`;
      tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : "";
      // Compact status for TUI (avoid multi-line spam)
      console.log(`[Mirror] ${mirrorUrl}${tailscaleUrl ? ` · TS ${tailscaleUrl}` : ""}`);
      try {
        ctx.ui.setStatus("mirror", `τ:${port}`);
      } catch { /* ignore */ }

      // Register this instance
      const sessionFile = ctx.sessionManager.getSessionFile() || "";
      registerInstance(port, sessionFile, ctx.cwd || process.cwd());

      // One short notify — not a wall of text
      try {
        ctx.ui.notify(`Tau ${mirrorUrl}`, "info");
      } catch { /* ignore */ }

      // Auto-open browser once — delayed so leftover-tab beacons cannot race startup
      if (TAU_AUTO_OPEN && !browserOpenedOnce) {
        browserOpenedOnce = true;
        const localUrl = `http://127.0.0.1:${port}`;
        setTimeout(() => {
          mlog(`[Mirror] Auto-opening browser: ${localUrl}`);
          openInBrowser(localUrl);
        }, 2000);
      }

      // Warm command cache + session capture
      refreshSessionCapture(ctx, pi as any);
      void listAllCommands(true);
    };

    tryListen(PORT);
  }

  // ═══════════════════════════════════════
  // Auto-start on session begin
  // ═══════════════════════════════════════
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    invalidateCommands("session_start");
    gitCache = null;
    refreshSessionCapture(ctx, pi as any);

    // Warm interactive bind capture (do not close over this session's ExtensionContext)
    const tryCaptureSwitcher = () => {
      try {
        pi.getCommands?.();
        // refresh only — bindCommandContext patch stores interactive switchSession
        refreshSessionCapture(undefined, pi as any);
      } catch { /* ignore */ }
    };
    tryCaptureSwitcher();
    setTimeout(tryCaptureSwitcher, 300);
    setTimeout(tryCaptureSwitcher, 1000);

    // Skip mirror startup in subagent child processes
    // (pi-subagents sets PI_SUBAGENT_CHILD=1; child processes loading Tau
    // should not attempt to start their own mirror server)
    if (process.env.PI_SUBAGENT_CHILD === "1") {
      mlog("[Mirror] Subagent child — skip auto-start");
      return;
    }

    const sessionFile = ctx.sessionManager.getSessionFile() || "";
    const cwd = (ctx as any).cwd || process.cwd();

    // Server already up (e.g. after live session switch) — rebind identity + push snapshot.
    // Do NOT restart the HTTP/WS stack; that drops browser clients mid-switch.
    if (server) {
      updateInstanceSession(sessionFile, cwd);
      mlog(`[Mirror] Session start (server up) → ${sessionFile || "(no file)"}`);
      try {
        const snapshot = await buildStateSnapshot(ctx);
        broadcast(snapshot);
      } catch (e) {
        mwarn("[Mirror] Failed to broadcast post-switch snapshot:", e);
      }
      return;
    }

    if (!TAU_AUTO_START) {
      mlog("[Mirror] Auto-start disabled (TAU_DISABLED=1)");
      return;
    }

    startServer(ctx);
  });

  // ═══════════════════════════════════════
  // Cleanup — NEVER process.exit from Tau
  // ═══════════════════════════════════════
  pi.on("session_shutdown", async () => {
    mlog("[Mirror] Session ended (mirror kept alive)");
  });

  // Quiet startup: one line only (set TAU_DEBUG=1 for verbose)
  if (factoryInvokeCount === 1) {
    console.log(`[Mirror] Tau ${TAU_BUILD_ID} · :${PORT}${TAU_DEBUG ? " · debug" : ""}`);
  }
}
