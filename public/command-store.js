/**
 * CommandStore — shared command list, search, and recent usage
 */

const RECENT_KEY = 'tau-recent-commands';
const MAX_RECENT = 12;

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch { /* ignore */ }
}

export const commandState = {
  items: [],
  filtered: [],
  query: '',
  selectedIndex: 0,
  isOpen: false,
  isLoading: false,
  error: null,
  lastFetchedAt: 0,
  adapter: null,
};

export function scoreCommand(cmd, query) {
  if (!query) return cmd._recentBoost || 0;
  const q = query.toLowerCase();
  const name = (cmd.name || '').toLowerCase();
  const inv = (cmd.invocation || '').toLowerCase();
  const desc = (cmd.description || '').toLowerCase();
  let score = 0;
  if (name === q || inv === `/${q}` || inv === q) score += 100;
  else if (name.startsWith(q) || inv.startsWith(`/${q}`)) score += 60;
  else if (name.includes(q) || inv.includes(q)) score += 35;
  if (desc.includes(q)) score += 15;
  if (cmd._recentBoost) score += cmd._recentBoost;
  if (cmd.location === 'project') score += 5;
  return score;
}

export function filterCommands(items, query) {
  const recent = new Set(loadRecent());
  const enriched = items.map((c) => ({
    ...c,
    _recentBoost: recent.has(c.invocation) || recent.has(c.name) ? 10 : 0,
  }));

  if (!query) {
    // Group: recent first, then by source order
    const order = { tau: 0, extension: 1, prompt: 2, skill: 3, tui: 4 };
    return enriched.sort((a, b) => {
      if ((b._recentBoost || 0) !== (a._recentBoost || 0)) {
        return (b._recentBoost || 0) - (a._recentBoost || 0);
      }
      return (order[a.source] ?? 9) - (order[b.source] ?? 9);
    });
  }

  return enriched
    .map((c) => ({ c, s: scoreCommand(c, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

export function markRecent(cmd) {
  const list = loadRecent().filter((x) => x !== cmd.invocation && x !== cmd.name);
  list.unshift(cmd.invocation || `/${cmd.name}`);
  saveRecent(list);
}

export function groupCommands(items) {
  const groups = {
    recent: [],
    extension: [],
    prompt: [],
    skill: [],
    tau: [],
    tui: [],
  };
  const recentSet = new Set(loadRecent());
  for (const c of items) {
    if (recentSet.has(c.invocation) || recentSet.has(c.name)) {
      groups.recent.push(c);
    } else if (groups[c.source]) {
      groups[c.source].push(c);
    } else {
      groups.extension.push(c);
    }
  }
  return groups;
}

export class CommandStore {
  constructor(wsClient) {
    this.ws = wsClient;
    this._pending = new Map();
    this._id = 0;
  }

  _nextId() {
    return `cmd-${++this._id}-${Date.now()}`;
  }

  async fetchCommands(refresh = false) {
    commandState.isLoading = true;
    commandState.error = null;

    // Prefer WebSocket RPC-style if available
    return new Promise((resolve) => {
      const id = this._nextId();
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        // Fall back to cached items
        commandState.isLoading = false;
        if (!commandState.items.length) {
          commandState.error = 'Command list unavailable';
        }
        resolve(commandState.items);
      }, 4000);

      this._pending.set(id, (resp) => {
        clearTimeout(timeout);
        commandState.isLoading = false;
        if (resp.success && resp.data?.commands) {
          commandState.items = resp.data.commands;
          commandState.adapter = resp.data.adapter || null;
          commandState.lastFetchedAt = Date.now();
          commandState.error = null;
          // Re-style composer if a slash token is already present
          try {
            document.getElementById('message-input')?.dispatchEvent(new Event('input'));
          } catch { /* ignore */ }
        } else {
          commandState.error = resp.error || 'Failed to load commands';
        }
        resolve(commandState.items);
      });

      this.ws.send({ type: 'get_commands', id, refresh: !!refresh });
    });
  }

  handleResponse(message) {
    if (!message?.id || !this._pending.has(message.id)) return false;
    const resolve = this._pending.get(message.id);
    this._pending.delete(message.id);
    resolve(message);
    return true;
  }

  setFromMirrorSync(commands, adapter) {
    if (Array.isArray(commands) && commands.length) {
      commandState.items = commands;
      commandState.lastFetchedAt = Date.now();
    }
    if (adapter) commandState.adapter = adapter;
  }

  search(query) {
    commandState.query = query || '';
    commandState.filtered = filterCommands(commandState.items, commandState.query);
    commandState.selectedIndex = 0;
    return commandState.filtered;
  }

  async execute(invocation, streamingBehavior) {
    return new Promise((resolve) => {
      const id = this._nextId();
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        resolve({ success: false, error: 'Timeout' });
      }, 8000);
      this._pending.set(id, (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      });
      this.ws.send({
        type: 'execute_command',
        id,
        invocation,
        streamingBehavior,
      });
    });
  }
}
