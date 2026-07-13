/**
 * Slash command completion popup for the message input
 *
 * Uses position:fixed so it is not clipped by .input-area overflow.
 */

import { commandState, markRecent, groupCommands } from './command-store.js';

const SOURCE_LABEL = {
  extension: 'EXTENSION',
  prompt: 'PROMPT',
  skill: 'SKILL',
  tau: 'TAU',
  tui: 'TERMINAL',
};

const LOCATION_LABEL = {
  user: 'USER',
  project: 'PROJECT',
  path: 'CUSTOM',
  builtin: '',
  unknown: '',
};

const GROUP_TITLE = {
  recent: 'Recently Used',
  extension: 'Pi Extensions',
  prompt: 'Prompt Templates',
  skill: 'Skills',
  tau: 'Tau Actions',
  tui: 'Terminal-only',
};

export function createSlashCompletion({ input, popup, store, onInsert, onExecute, onTauAction, isReadOnly }) {
  let composing = false;
  let fetchPromise = null;

  // Detach from overflow-clipped parents: park popup on document.body
  if (popup.parentElement !== document.body) {
    document.body.appendChild(popup);
  }
  popup.classList.add('slash-popup--fixed');

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    onInput();
  });

  function getSlashToken() {
    const value = input.value;
    const caret = input.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    if (before.includes('\n')) return null;
    if (!before.startsWith('/')) return null;
    const m = before.match(/^\/([^\s]*)$/);
    if (!m) return null;
    return { query: m[1], start: 0, end: caret };
  }

  function positionPopup() {
    const rect = input.getBoundingClientRect();
    // Prefer anchoring above the input bubble
    const wrap = input.closest('.input-bubble') || input.closest('.input-bubble-wrap') || input;
    const anchor = wrap.getBoundingClientRect();
    const gap = 10;
    const maxH = Math.min(window.innerHeight * 0.45, 420);
    const spaceAbove = anchor.top - gap - 12;
    const spaceBelow = window.innerHeight - anchor.bottom - gap - 12;

    let top;
    let height = Math.min(maxH, Math.max(spaceAbove, spaceBelow, 160));

    if (spaceAbove >= 180 || spaceAbove >= spaceBelow) {
      // open upward
      height = Math.min(maxH, Math.max(120, spaceAbove));
      top = Math.max(8, anchor.top - gap - height);
    } else {
      // open downward
      height = Math.min(maxH, Math.max(120, spaceBelow));
      top = anchor.bottom + gap;
    }

    const left = Math.max(12, anchor.left);
    const width = Math.min(anchor.width, window.innerWidth - left - 12);

    popup.style.position = 'fixed';
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${height}px`;
    popup.style.bottom = 'auto';
    popup.style.right = 'auto';
    popup.style.zIndex = '10050';
  }

  function close() {
    commandState.isOpen = false;
    popup.classList.add('hidden');
    popup.innerHTML = '';
  }

  async function ensureCommands() {
    if (commandState.items.length) return;
    if (fetchPromise) return fetchPromise;
    commandState.isLoading = true;
    fetchPromise = store.fetchCommands(false).finally(() => {
      fetchPromise = null;
      commandState.isLoading = false;
    });
    return fetchPromise;
  }

  function openWith(query) {
    if (isReadOnly?.()) {
      commandState.isOpen = true;
      popup.classList.remove('hidden');
      positionPopup();
      popup.innerHTML = `<div class="slash-empty">Historical sessions are read-only</div>`;
      return;
    }

    const items = store.search(query);
    commandState.isOpen = true;
    commandState.filtered = items;
    commandState.selectedIndex = 0;
    positionPopup();
    render();

    // If empty, try loading then re-open
    if (!commandState.items.length) {
      ensureCommands().then(() => {
        if (!commandState.isOpen) return;
        if (!getSlashToken()) return;
        commandState.filtered = store.search(commandState.query);
        commandState.selectedIndex = 0;
        positionPopup();
        render();
      });
    }
  }

  function render() {
    const items = commandState.filtered;
    popup.classList.remove('hidden');
    positionPopup();

    if (!items.length) {
      const msg = commandState.isLoading
        ? 'Loading commands…'
        : commandState.error
          ? escapeHtml(commandState.error)
          : 'No matching commands';
      popup.innerHTML = `<div class="slash-empty">${msg}</div>`;
      return;
    }

    const showGroups = !commandState.query;
    let html = '';

    if (showGroups) {
      const groups = groupCommands(items);
      let flatIndex = 0;
      const flat = [];
      for (const key of ['recent', 'extension', 'prompt', 'skill', 'tau', 'tui']) {
        const list = groups[key];
        if (!list?.length) continue;
        html += `<div class="slash-group-title">${GROUP_TITLE[key]}</div>`;
        for (const cmd of list) {
          flat.push(cmd);
          html += renderItem(cmd, flatIndex === commandState.selectedIndex);
          flatIndex++;
        }
      }
      // Fallback: if grouping produced nothing but items exist, flat-render
      if (!flat.length) {
        items.forEach((cmd, i) => {
          flat.push(cmd);
          html += renderItem(cmd, i === commandState.selectedIndex);
        });
      }
      commandState.filtered = flat.length ? flat : items;
    } else {
      items.forEach((cmd, i) => {
        html += renderItem(cmd, i === commandState.selectedIndex);
      });
    }

    popup.innerHTML = html;

    popup.querySelectorAll('.slash-item').forEach((el, i) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        commandState.selectedIndex = i;
        insertSelected(false);
      });
    });

    const sel = popup.querySelector('.slash-item.selected');
    sel?.scrollIntoView({ block: 'nearest' });
  }

  function renderItem(cmd, selected) {
    const src = SOURCE_LABEL[cmd.source] || cmd.source?.toUpperCase() || '';
    const loc = LOCATION_LABEL[cmd.location] || '';
    const cap =
      cmd.capability === 'terminal-only'
        ? 'TERMINAL'
        : cmd.capability === 'insert-only'
          ? 'INSERT'
          : cmd.capability === 'unavailable'
            ? 'N/A'
            : '';
    const badges = [src, loc, cap].filter(Boolean).map((b) => `<span class="slash-badge">${b}</span>`).join('');
    return `
      <div class="slash-item${selected ? ' selected' : ''}" data-invocation="${escapeAttr(cmd.invocation)}">
        <div class="slash-item-main">
          <span class="slash-name">${escapeHtml(cmd.invocation)}</span>
          <span class="slash-desc">${escapeHtml(cmd.description || '')}</span>
        </div>
        <div class="slash-badges">${badges}</div>
      </div>`;
  }

  function selectedCmd() {
    return commandState.filtered[commandState.selectedIndex] || null;
  }

  function insertSelected(execute) {
    const cmd = selectedCmd();
    if (!cmd) return;
    markRecent(cmd);

    if (cmd.source === 'tau') {
      close();
      onTauAction?.(cmd);
      return;
    }

    if (cmd.capability === 'terminal-only') {
      onInsert?.(`${cmd.invocation} `);
      close();
      const st = document.getElementById('status-text');
      if (st) {
        st.textContent = 'Terminal-only — run in Pi TUI';
        setTimeout(() => { st.textContent = 'Connected'; }, 2500);
      }
      return;
    }

    if (execute && cmd.capability === 'execute') {
      close();
      onExecute?.(cmd);
      return;
    }

    onInsert?.(`${cmd.invocation} `);
    close();
  }

  function onInput() {
    if (composing) return;
    const token = getSlashToken();
    if (!token) {
      if (commandState.isOpen) close();
      return;
    }
    openWith(token.query);
  }

  function onKeydown(e) {
    if (!commandState.isOpen) return false;

    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return true;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      commandState.selectedIndex = Math.min(
        commandState.selectedIndex + 1,
        Math.max(0, commandState.filtered.length - 1)
      );
      render();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      commandState.selectedIndex = Math.max(0, commandState.selectedIndex - 1);
      render();
      return true;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      commandState.selectedIndex = 0;
      render();
      return true;
    }
    if (e.key === 'End') {
      e.preventDefault();
      commandState.selectedIndex = Math.max(0, commandState.filtered.length - 1);
      render();
      return true;
    }
    if (e.key === 'PageDown') {
      e.preventDefault();
      commandState.selectedIndex = Math.min(
        commandState.selectedIndex + 8,
        Math.max(0, commandState.filtered.length - 1)
      );
      render();
      return true;
    }
    if (e.key === 'PageUp') {
      e.preventDefault();
      commandState.selectedIndex = Math.max(0, commandState.selectedIndex - 8);
      render();
      return true;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      insertSelected(false);
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        insertSelected(true);
      } else {
        insertSelected(false);
      }
      return true;
    }
    return false;
  }

  window.addEventListener('resize', () => {
    if (commandState.isOpen) positionPopup();
  });
  // Reposition when messages scroll (input is fixed to bottom)
  document.getElementById('messages-scroll')?.addEventListener('scroll', () => {
    if (commandState.isOpen) positionPopup();
  }, { passive: true });

  return { onInput, onKeydown, close, openWith, isOpen: () => commandState.isOpen };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
