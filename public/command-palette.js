/**
 * Top Command Center (PI COMMANDS | TAU ACTIONS)
 */

import { commandState, markRecent, filterCommands } from './command-store.js';

const SOURCE_LABEL = {
  extension: 'EXTENSION',
  prompt: 'PROMPT',
  skill: 'SKILL',
  tau: 'TAU',
  tui: 'TERMINAL',
};

export function createCommandPalette({
  palette,
  overlay,
  listEl,
  store,
  onTauAction,
  onExecute,
  onInsert,
}) {
  let tab = 'pi'; // 'pi' | 'tau'
  let query = '';

  function open() {
    if (!commandState.items.length) {
      store.fetchCommands(false);
    }
    render();
    palette.classList.remove('hidden');
    overlay.classList.remove('hidden');
    const search = palette.querySelector('.cc-search');
    search?.focus();
  }

  function close() {
    palette.classList.add('hidden');
    overlay.classList.add('hidden');
  }

  function render() {
    const piItems = commandState.items.filter((c) => c.source !== 'tau');
    const tauItems = commandState.items.filter((c) => c.source === 'tau');
    const base = tab === 'pi' ? piItems : tauItems;
    const items = filterCommands(base, query);

    palette.innerHTML = `
      <div class="command-palette-header cc-header">
        <div class="cc-tabs">
          <button type="button" class="cc-tab${tab === 'pi' ? ' active' : ''}" data-tab="pi">PI COMMANDS</button>
          <button type="button" class="cc-tab${tab === 'tau' ? ' active' : ''}" data-tab="tau">TAU ACTIONS</button>
        </div>
        <input class="cc-search" type="search" placeholder="Search commands…" value="${escapeAttr(query)}" />
      </div>
      <div class="command-list" id="command-list-dynamic"></div>
      ${commandState.adapter?.degraded ? '<div class="cc-degraded">Pi command registry partially unavailable</div>' : ''}
    `;

    const list = palette.querySelector('#command-list-dynamic');
    if (!items.length) {
      list.innerHTML = `<div class="slash-empty">${commandState.isLoading ? 'Loading…' : 'No commands'}</div>`;
    } else {
      for (const cmd of items) {
        const el = document.createElement('div');
        el.className = 'command-item';
        el.innerHTML = `
          <div class="command-icon">${iconFor(cmd)}</div>
          <div>
            <div class="command-label">${escapeHtml(cmd.invocation)}</div>
            <div class="command-desc">${escapeHtml(cmd.description || '')}</div>
          </div>
          <div class="slash-badges">
            <span class="slash-badge">${SOURCE_LABEL[cmd.source] || ''}</span>
            ${cmd.capability && cmd.capability !== 'execute' ? `<span class="slash-badge">${cmd.capability}</span>` : ''}
          </div>
        `;
        el.addEventListener('click', () => {
          close();
          handleCmd(cmd);
        });
        list.appendChild(el);
      }
    }

    palette.querySelectorAll('.cc-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        tab = btn.dataset.tab;
        render();
      });
    });
    const search = palette.querySelector('.cc-search');
    search?.addEventListener('input', () => {
      query = search.value;
      render();
      // restore focus & caret
      const s2 = palette.querySelector('.cc-search');
      if (s2) {
        s2.focus();
        s2.value = query;
        s2.setSelectionRange(query.length, query.length);
      }
    });
  }

  function handleCmd(cmd) {
    markRecent(cmd);
    // Tau Web actions only
    if (cmd.source === 'tau') {
      onTauAction?.(cmd);
      return;
    }
    // Pi / TUI / extension / skill / prompt → always go through Pi execute path
    if (cmd.capability === 'execute') {
      onExecute?.(cmd);
    } else {
      onInsert?.(`${cmd.invocation} `);
    }
  }

  overlay.addEventListener('click', close);

  return { open, close, render };
}

function iconFor(cmd) {
  if (cmd.source === 'skill') return '⚡';
  if (cmd.source === 'prompt') return '📝';
  if (cmd.source === 'tau') return 'τ';
  if (cmd.source === 'tui') return '⌨';
  return '▸';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}
