/**
 * Pi command discovery & execution adapter.
 *
 * - Discovery uses the public ExtensionAPI: pi.getCommands()
 * - Execution prefers AgentSession.prompt() when capturable (same semantics as TUI/RPC)
 * - Falls back to expand+sendUserMessage for skills/prompts, and runner handlers for extensions
 * - All private-API probing is confined to this file
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type CommandSource = "extension" | "prompt" | "skill" | "tau" | "tui";
export type CommandLocation = "user" | "project" | "path" | "builtin" | "unknown";
export type CommandCapability = "execute" | "insert-only" | "terminal-only" | "unavailable";

export interface CommandDescriptor {
  id: string;
  name: string;
  invocation: string;
  description?: string;
  source: CommandSource;
  location: CommandLocation;
  path?: string;
  capability: CommandCapability;
  acceptsArgs: boolean | "unknown";
  availableWhileStreaming: boolean;
  keywords?: string[];
}

export interface AdapterInfo {
  mode: "public-v1" | "internal-v1" | "degraded";
  piVersion?: string;
  degraded: boolean;
  message?: string;
}

export interface ExecuteResult {
  accepted: boolean;
  executionMode: string;
  error?: string;
}

export interface PiCommandAdapter {
  supported(): boolean;
  list(): Promise<CommandDescriptor[]>;
  execute(invocation: string, options?: { streamingBehavior?: "immediate" | "steer" | "followUp" }): Promise<ExecuteResult>;
  info(): AdapterInfo;
}

type PiLike = {
  getCommands?: () => Array<{
    name: string;
    description?: string;
    source: "extension" | "prompt" | "skill";
    sourceInfo?: { path?: string; scope?: string; source?: string; origin?: string; baseDir?: string };
  }>;
  sendUserMessage?: (content: string | unknown[], options?: { deliverAs?: "steer" | "followUp" }) => void;
  getSessionName?: () => string | undefined;
  getThinkingLevel?: () => string;
};

let capturedSession: any = null;
let capturedRunner: any = null;
/** Live switchSession from interactive mode (bound via bindCommandContext) */
let capturedSwitchSession:
  | ((sessionPath: string, options?: any) => Promise<{ cancelled?: boolean }>)
  | null = null;
let patched = false;

function resolvePiPkgRoot(): string | null {
  const names = ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"];
  const requireBases: string[] = [];

  // 1) Running Pi CLI path — same node_modules the process actually uses
  if (process.argv[1]) requireBases.push(process.argv[1]);
  // 2) This adapter file
  try {
    requireBases.push(import.meta.url);
  } catch { /* ignore */ }
  // 3) Common global install locations
  if (process.env.APPDATA) {
    requireBases.push(path.join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
  }
  if (process.env.HOME || process.env.USERPROFILE) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    requireBases.push(path.join(home, "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
  }

  for (const base of requireBases) {
    try {
      const req = createRequire(base.startsWith("file:") ? base : pathToFileURL(base).href);
      for (const name of names) {
        try {
          return path.dirname(req.resolve(`${name}/package.json`));
        } catch { /* next name */ }
      }
    } catch { /* next base */ }
  }

  // Direct filesystem probe
  for (const name of names) {
    const probe = process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", name)
      : "";
    if (probe && fs.existsSync(path.join(probe, "package.json"))) return probe;
  }
  return null;
}

function tryPatchInternals(): void {
  if (patched) return;
  patched = true;

  try {
    const pkgRoot = resolvePiPkgRoot();
    if (!pkgRoot) {
      console.warn("[Tau] Could not resolve pi-coding-agent package for session switch hooks");
      return;
    }
    console.log("[Tau] Hooking pi-coding-agent at", pkgRoot);

    const sessionPath = path.join(pkgRoot, "dist", "core", "agent-session.js");
    const runnerPath = path.join(pkgRoot, "dist", "core", "extensions", "runner.js");
    // Also try runtime for switchSession on AgentSessionRuntime
    const runtimePath = path.join(pkgRoot, "dist", "core", "agent-session-runtime.js");

    void (async () => {
      try {
        if (fs.existsSync(sessionPath)) {
          const mod = await import(pathToFileURL(sessionPath).href);
          const AS = mod.AgentSession;
          if (AS?.prototype && !AS.prototype.__tauCapture) {
            const methods = ["getContextUsage", "isIdle", "prompt"] as const;
            for (const m of methods) {
              const orig = AS.prototype[m];
              if (typeof orig !== "function") continue;
              AS.prototype[m] = function (this: any, ...args: any[]) {
                capturedSession = this;
                if (this?._extensionRunner) capturedRunner = this._extensionRunner;
                return orig.apply(this, args);
              };
            }
            AS.prototype.__tauCapture = true;
          }
        }
      } catch (e) {
        console.warn("[Tau] AgentSession capture patch failed:", (e as Error).message);
      }

      try {
        if (fs.existsSync(runnerPath)) {
          const mod = await import(pathToFileURL(runnerPath).href);
          const ER = mod.ExtensionRunner;
          if (ER?.prototype && !ER.prototype.__tauCapture) {
            const origGet = ER.prototype.getRegisteredCommands;
            if (typeof origGet === "function") {
              ER.prototype.getRegisteredCommands = function (this: any, ...args: any[]) {
                capturedRunner = this;
                return origGet.apply(this, args);
              };
            }
            // Capture real switchSession from interactive mode bind
            const origBind = ER.prototype.bindCommandContext;
            if (typeof origBind === "function") {
              ER.prototype.bindCommandContext = function (this: any, actions: any) {
                const result = origBind.call(this, actions);
                capturedRunner = this;
                if (actions?.switchSession) {
                  capturedSwitchSession = (sessionPath: string, options?: any) =>
                    actions.switchSession(sessionPath, options);
                  console.log("[Tau] Captured live switchSession handler");
                }
                return result;
              };
            }
            // Also capture via createCommandContext calls
            const origCreate = ER.prototype.createCommandContext;
            if (typeof origCreate === "function") {
              ER.prototype.createCommandContext = function (this: any, ...args: any[]) {
                capturedRunner = this;
                const ctx = origCreate.apply(this, args);
                if (ctx && typeof ctx.switchSession === "function" && this.switchSessionHandler) {
                  // Prefer bound handler on runner if not the noop
                  const h = this.switchSessionHandler;
                  if (h && !String(h).includes("cancelled: false") || true) {
                    capturedSwitchSession = (p: string, o?: any) => ctx.switchSession(p, o);
                  }
                }
                return ctx;
              };
            }
            ER.prototype.__tauCapture = true;
          }
        }
      } catch (e) {
        console.warn("[Tau] ExtensionRunner capture patch failed:", (e as Error).message);
      }

      try {
        if (fs.existsSync(runtimePath)) {
          const mod = await import(pathToFileURL(runtimePath).href);
          const RT = mod.AgentSessionRuntime;
          if (RT?.prototype?.switchSession && !RT.prototype.__tauCapture) {
            const orig = RT.prototype.switchSession;
            RT.prototype.switchSession = function (this: any, ...args: any[]) {
              // Keep a direct runtime switch fallback
              capturedSwitchSession = (p: string, o?: any) => orig.call(this, p, o);
              return orig.apply(this, args);
            };
            RT.prototype.__tauCapture = true;
          }
        }
      } catch (e) {
        console.warn("[Tau] AgentSessionRuntime capture patch failed:", (e as Error).message);
      }
    })();
  } catch (e) {
    console.warn("[Tau] Internal adapter patch setup failed:", (e as Error).message);
  }
}

/** Called from mirror-server with ExtensionCommandContext when available */
export function setSessionSwitcher(
  fn: (sessionPath: string, options?: any) => Promise<{ cancelled?: boolean }>
): void {
  capturedSwitchSession = fn;
}

function mapScope(scope?: string): CommandLocation {
  if (scope === "user") return "user";
  if (scope === "project") return "project";
  if (scope === "temporary") return "path";
  return "unknown";
}

function mapSourceInfoPath(info?: { path?: string }): string | undefined {
  return info?.path;
}

function toDescriptor(cmd: {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: { path?: string; scope?: string };
}, canExecute: boolean): CommandDescriptor {
  const invocation = cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`;
  const name = cmd.name.startsWith("/") ? cmd.name.slice(1) : cmd.name;
  return {
    id: `${cmd.source}:${mapScope(cmd.sourceInfo?.scope)}:${name}`,
    name,
    invocation,
    description: cmd.description,
    source: cmd.source,
    location: mapScope(cmd.sourceInfo?.scope),
    path: mapSourceInfoPath(cmd.sourceInfo),
    capability: canExecute ? "execute" : "insert-only",
    acceptsArgs: "unknown",
    availableWhileStreaming: cmd.source === "extension",
  };
}

/**
 * Pi TUI built-ins that are NOT owned by Tau.
 * Slash names (/settings, /model, …) stay with Pi — try session.prompt first.
 * Web UI equivalents stay on buttons / /tau:* actions only.
 */
const TUI_BUILTINS: CommandDescriptor[] = [
  {
    id: "tui:builtin:settings",
    name: "settings",
    invocation: "/settings",
    description: "Pi TUI settings (terminal). Use the gear icon for Tau Web settings.",
    source: "tui",
    location: "builtin",
    capability: "execute", // try Pi first via session.prompt; fall back to terminal-only message
    acceptsArgs: false,
    availableWhileStreaming: true,
  },
  {
    id: "tui:builtin:model",
    name: "model",
    invocation: "/model",
    description: "Pi TUI model picker. Use the header model button for Tau Web.",
    source: "tui",
    location: "builtin",
    capability: "execute",
    acceptsArgs: true,
    availableWhileStreaming: true,
  },
  {
    id: "tui:builtin:thinking",
    name: "thinking",
    invocation: "/thinking",
    description: "Pi TUI thinking level. Use the header thinking chip for Tau Web.",
    source: "tui",
    location: "builtin",
    capability: "execute",
    acceptsArgs: true,
    availableWhileStreaming: true,
  },
  {
    id: "tui:builtin:compact",
    name: "compact",
    invocation: "/compact",
    description: "Pi compact command. Use Command Center → TAU ACTIONS for Tau compact.",
    source: "tui",
    location: "builtin",
    capability: "execute",
    acceptsArgs: true,
    availableWhileStreaming: false,
  },
  {
    id: "tui:builtin:hotkeys",
    name: "hotkeys",
    invocation: "/hotkeys",
    description: "Pi TUI hotkeys reference (terminal only)",
    source: "tui",
    location: "builtin",
    capability: "terminal-only",
    acceptsArgs: false,
    availableWhileStreaming: false,
  },
];

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  return content.slice(end + 4);
}

function expandSkill(filePath: string, skillName: string, args: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const body = stripFrontmatter(raw).trim();
    const baseDir = path.dirname(filePath);
    const skillBlock = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
    return args ? `${skillBlock}\n\n${args}` : skillBlock;
  } catch {
    return null;
  }
}

function expandPromptTemplate(filePath: string, args: string): string | null {
  try {
    let content = fs.readFileSync(filePath, "utf-8");
    content = stripFrontmatter(content).trim();
    // Simple $1..$n and $@ substitution
    const parts = args.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const clean = parts.map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p));
    let result = content;
    result = result.replace(/\$@/g, args);
    result = result.replace(/\$(\d+)/g, (_m, n) => clean[parseInt(n, 10) - 1] ?? "");
    return result;
  } catch {
    return null;
  }
}

function parseInvocation(invocation: string): { name: string; args: string } {
  const text = invocation.trim();
  const body = text.startsWith("/") ? text.slice(1) : text;
  const space = body.indexOf(" ");
  if (space === -1) return { name: body, args: "" };
  return { name: body.slice(0, space), args: body.slice(space + 1) };
}

export function createPiCommandAdapter(pi: PiLike): PiCommandAdapter {
  tryPatchInternals();

  let mode: AdapterInfo["mode"] = "degraded";
  let message: string | undefined;

  const hasGetCommands = typeof pi.getCommands === "function";
  if (hasGetCommands) {
    mode = "public-v1";
  } else {
    message = "pi.getCommands() is unavailable for this Pi version";
  }

  function refreshCapture(ctx?: { getContextUsage?: () => unknown }): void {
    try {
      ctx?.getContextUsage?.();
    } catch { /* ignore */ }
    try {
      pi.getCommands?.();
    } catch { /* ignore */ }
    if (capturedSession && typeof capturedSession.prompt === "function") {
      mode = mode === "degraded" ? "internal-v1" : mode;
    }
  }

  return {
    supported() {
      return hasGetCommands || !!capturedSession;
    },

    info() {
      return {
        mode: capturedSession ? (hasGetCommands ? "public-v1" : "internal-v1") : hasGetCommands ? "public-v1" : "degraded",
        degraded: !hasGetCommands && !capturedSession,
        message,
      };
    },

    async list() {
      refreshCapture();
      const canExecuteFully = !!(capturedSession && typeof capturedSession.prompt === "function");
      const canExecutePartial = typeof pi.sendUserMessage === "function";

      const out: CommandDescriptor[] = [...TUI_BUILTINS];

      if (!hasGetCommands) {
        mode = "degraded";
        return out;
      }

      try {
        const cmds = pi.getCommands!() || [];
        for (const c of cmds) {
          const canExec =
            canExecuteFully ||
            (canExecutePartial && (c.source === "skill" || c.source === "prompt")) ||
            (c.source === "extension" && !!capturedRunner);
          out.push(toDescriptor(c, canExec));
        }
        mode = "public-v1";
      } catch (e) {
        mode = "degraded";
        message = e instanceof Error ? e.message : String(e);
      }

      return out;
    },

    async execute(invocation, options) {
      refreshCapture();
      const raw = (invocation || "").trim();
      if (!raw.startsWith("/")) {
        return { accepted: false, executionMode: "none", error: "Invocation must start with /" };
      }
      if (raw.length > 8192) {
        return { accepted: false, executionMode: "none", error: "Invocation too long" };
      }

      const { name, args } = parseInvocation(raw);
      if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) {
        return { accepted: false, executionMode: "none", error: "Invalid command name" };
      }

      // Prefer session.prompt — same path as TUI and RPC
      if (capturedSession && typeof capturedSession.prompt === "function") {
        try {
          const isStreaming = typeof capturedSession.isStreaming === "boolean"
            ? capturedSession.isStreaming
            : (typeof capturedSession.isIdle === "function" ? !capturedSession.isIdle() : false);

          const streamingBehavior =
            options?.streamingBehavior === "immediate"
              ? "steer"
              : options?.streamingBehavior === "followUp"
                ? "followUp"
                : options?.streamingBehavior === "steer"
                  ? "steer"
                  : isStreaming
                    ? "followUp"
                    : undefined;

          await capturedSession.prompt(raw, {
            expandPromptTemplates: true,
            ...(streamingBehavior ? { streamingBehavior } : {}),
            source: "extension",
          });
          return { accepted: true, executionMode: "pi-session-prompt" };
        } catch (e) {
          return {
            accepted: false,
            executionMode: "pi-session-prompt",
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }

      // Extension command via runner handler
      if (capturedRunner && typeof capturedRunner.getCommand === "function") {
        const command = capturedRunner.getCommand(name);
        if (command?.handler) {
          try {
            const cmdCtx = capturedRunner.createCommandContext();
            await command.handler(args, cmdCtx);
            return { accepted: true, executionMode: "pi-runner-handler" };
          } catch (e) {
            return {
              accepted: false,
              executionMode: "pi-runner-handler",
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }
      }

      // Skill / prompt expansion fallback
      let listed: CommandDescriptor[] = [];
      try {
        listed = await this.list();
      } catch { /* ignore */ }

      const match = listed.find(
        (c) => c.name === name || c.invocation === raw.split(/\s/)[0]
      );

      if (match?.source === "skill" && match.path) {
        const skillName = name.startsWith("skill:") ? name.slice(6) : name;
        const expanded = expandSkill(match.path, skillName, args);
        if (expanded && pi.sendUserMessage) {
          const deliverAs =
            options?.streamingBehavior === "steer" || options?.streamingBehavior === "immediate"
              ? "steer"
              : options?.streamingBehavior === "followUp"
                ? "followUp"
                : undefined;
          pi.sendUserMessage(expanded, deliverAs ? { deliverAs } : undefined);
          return { accepted: true, executionMode: "expand-skill" };
        }
      }

      if (match?.source === "prompt" && match.path) {
        const expanded = expandPromptTemplate(match.path, args);
        if (expanded && pi.sendUserMessage) {
          const deliverAs =
            options?.streamingBehavior === "steer" || options?.streamingBehavior === "immediate"
              ? "steer"
              : options?.streamingBehavior === "followUp"
                ? "followUp"
                : undefined;
          pi.sendUserMessage(expanded, deliverAs ? { deliverAs } : undefined);
          return { accepted: true, executionMode: "expand-prompt" };
        }
      }

      // NEVER fall back to sendUserMessage(raw invocation)
      return {
        accepted: false,
        executionMode: "unavailable",
        error: "Cannot execute this command for the current Pi runtime. Inserted as text only.",
      };
    },
  };
}

/** Allow external refresh of capture (e.g. after ctx.getContextUsage) */
export function refreshSessionCapture(ctx?: { getContextUsage?: () => unknown }, pi?: PiLike): void {
  try {
    ctx?.getContextUsage?.();
  } catch { /* ignore */ }
  try {
    pi?.getCommands?.();
  } catch { /* ignore */ }
}

/** Read cwd from a Pi session .jsonl (first `type:"session"` entry). */
export function readSessionCwd(sessionFile: string): string | null {
  try {
    const fd = fs.openSync(sessionFile, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row?.type === "session" && typeof row.cwd === "string" && row.cwd) {
            return row.cwd;
          }
          if (typeof row?.cwd === "string" && row.cwd) return row.cwd;
        } catch {
          /* next line */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore */
  }
  return null;
}

function normalizePathKey(p: string): string {
  return p
    .trim()
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Block process.exit during resume — Pi's handleResumeSession calls
 * handleFatalRuntimeError → process.exit(1) on non-cwd failures, which kills TUI.
 */
async function withBlockedProcessExit<T>(fn: () => Promise<T>): Promise<T> {
  const realExit = process.exit.bind(process);
  let blockedExitCode: number | null = null;
  (process as any).exit = (code?: number) => {
    blockedExitCode = code ?? 0;
    console.warn(`[Tau] Blocked process.exit(${blockedExitCode}) during session resume`);
    throw new Error(`Session resume failed (Pi tried to exit with code ${blockedExitCode})`);
  };
  try {
    return await fn();
  } finally {
    process.exit = realExit as typeof process.exit;
  }
}

/**
 * Resume a session the same way TUI /resume does after you pick a row:
 * ExtensionCommandContext.switchSession(absolutePath) → interactive handleResumeSession.
 *
 * Only call for sessions whose cwd exists (and preferably matches process.cwd()).
 */
export async function resumeSessionLikeTui(
  sessionFile: string,
  options?: { requireSameCwd?: boolean; liveCwd?: string }
): Promise<{ ok: boolean; cancelled?: boolean; error?: string; sessionCwd?: string | null }> {
  tryPatchInternals();
  refreshSessionCapture();

  if (!sessionFile || typeof sessionFile !== "string") {
    return { ok: false, error: "sessionFile required" };
  }

  const resolved = path.resolve(sessionFile);
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `Session file not found: ${resolved}` };
  }

  const sessionCwd = readSessionCwd(resolved);
  if (sessionCwd && !fs.existsSync(sessionCwd)) {
    return {
      ok: false,
      error: `Session cwd does not exist: ${sessionCwd}. Open history read-only, or resume in TUI with /resume.`,
      sessionCwd,
    };
  }

  const liveCwd = options?.liveCwd || process.cwd();
  if (options?.requireSameCwd !== false && sessionCwd) {
    if (normalizePathKey(sessionCwd) !== normalizePathKey(liveCwd)) {
      return {
        ok: false,
        error: `Session is under another directory (${sessionCwd}). Live resume only for current cwd; use history browse or TUI /resume.`,
        sessionCwd,
      };
    }
  }

  // Prefer armed interactive switchSession (handleResumeSession) — same as picking in /resume UI
  const attempts: Array<() => Promise<{ cancelled?: boolean } | void>> = [];
  if (capturedSwitchSession) {
    attempts.push(() => capturedSwitchSession!(resolved));
  }
  if (capturedRunner && typeof capturedRunner.createCommandContext === "function") {
    attempts.push(async () => {
      const cmdCtx = capturedRunner.createCommandContext();
      if (typeof cmdCtx.switchSession !== "function") {
        throw new Error("createCommandContext().switchSession missing");
      }
      return cmdCtx.switchSession(resolved);
    });
  }
  if (capturedSession?.extensionRunner?.createCommandContext) {
    attempts.push(async () => {
      const cmdCtx = capturedSession.extensionRunner.createCommandContext();
      return cmdCtx.switchSession(resolved);
    });
  }

  if (!attempts.length) {
    return {
      ok: false,
      error:
        "Resume hook not ready. In the Pi terminal run: /tau-switch   (no args) once, then retry from Tau.",
      sessionCwd,
    };
  }

  try {
    const result = await withBlockedProcessExit(() => attempts[0]!());
    if (result && (result as any).cancelled) {
      return { ok: false, cancelled: true, error: "Session resume cancelled", sessionCwd };
    }
    console.log("[Tau] resume (like /resume pick) ok →", resolved);
    return { ok: true, sessionCwd };
  } catch (e) {
    const lastError = e instanceof Error ? e.message : String(e);
    console.warn("[Tau] resume failed:", lastError);
    if (/already|same session|no.?op|not modified/i.test(lastError)) {
      return { ok: true, sessionCwd };
    }
    return { ok: false, error: lastError, sessionCwd };
  }
}

/** @deprecated use resumeSessionLikeTui */
export async function switchPiSession(sessionFile: string) {
  return resumeSessionLikeTui(sessionFile, { requireSameCwd: false });
}

export { TUI_BUILTINS };
