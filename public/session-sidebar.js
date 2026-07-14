/**
 * Session Sidebar - Lists sessions grouped by project, handles switching
 */

/**
 * Normalize paths for equality checks.
 * Handles Windows drive letters, mixed slashes, and Pi session-dir decoding
 * (e.g. dir "--C--Users-14868--" → "/C//Users/14868").
 */
export function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  let s = p.trim()
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
  // Pi decode may yield "/C/Users/..." or "C/Users/..." (missing colon)
  const driveAbs = s.match(/^\/?([a-zA-Z])\/(.*)$/);
  if (driveAbs) s = `${driveAbs[1]}:/${driveAbs[2]}`;
  // Also normalize "C:/..." forms already correct
  s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

export function pathsEqual(a, b) {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return !!na && !!nb && na === nb;
}

export class SessionSidebar {
  constructor(container, onSessionSelect) {
    this.container = container;
    this.onSessionSelect = onSessionSelect;
    this.activeSessionFile = null;
    /** Live Pi process cwd — only sessions under this path can live-switch */
    this.liveCwd = null;
    this.projects = [];
    this.collapsedProjects = new Set();
    this.searchQuery = '';
    this.favourites = JSON.parse(localStorage.getItem('tau-favourites') || '[]');
    this.contextMenu = null;

    // Close context menu on click anywhere
    document.addEventListener('click', () => this.closeContextMenu());
    document.addEventListener('contextmenu', (e) => {
      // Close if right-clicking outside a session item
      if (!e.target.closest('.session-item')) this.closeContextMenu();
    });
  }

  /** Update live working directory; foreign projects become read-only in the UI */
  setLiveCwd(cwd) {
    const next = cwd || null;
    const unchanged =
      (!this.liveCwd && !next) || pathsEqual(this.liveCwd, next);
    this.liveCwd = next;
    if (unchanged) {
      this.applyForeignCwdStyles();
      return;
    }
    // Re-render so current-cwd projects float to the top and RO styles apply
    if (this.projects.length) this.render();
    else this.applyForeignCwdStyles();
  }

  isSameCwdProject(project) {
    if (!this.liveCwd) return true; // unknown → don't lock out
    if (!project?.path) return false;
    return pathsEqual(project.path, this.liveCwd);
  }

  applyForeignCwdStyles() {
    if (!this.container) return;
    this.container.querySelectorAll('.project-group').forEach((group) => {
      const path = group.dataset.projectPath || '';
      const foreign = this.liveCwd && path && !pathsEqual(path, this.liveCwd);
      group.classList.toggle('foreign-cwd', !!foreign);
      group.querySelectorAll('.session-item').forEach((el) => {
        el.classList.toggle('foreign-cwd', !!foreign);
        el.title = foreign
          ? 'Other directory — read-only history (live switch only for current cwd)'
          : '';
      });
    });
    // Favourites / search items carry data-project-path when available
    this.container.querySelectorAll('.session-item[data-project-path]').forEach((el) => {
      if (el.closest('.project-group')) return; // already handled
      const path = el.dataset.projectPath || '';
      const foreign = this.liveCwd && path && !pathsEqual(path, this.liveCwd);
      el.classList.toggle('foreign-cwd', !!foreign);
      el.title = foreign
        ? 'Other directory — read-only history (live switch only for current cwd)'
        : '';
    });
  }

  saveFavourites() {
    localStorage.setItem('tau-favourites', JSON.stringify(this.favourites));
  }

  isFavourite(filePath) {
    return this.favourites.includes(filePath);
  }

  toggleFavourite(filePath) {
    const idx = this.favourites.indexOf(filePath);
    if (idx >= 0) {
      this.favourites.splice(idx, 1);
    } else {
      this.favourites.push(filePath);
    }
    this.saveFavourites();
    this.render();
  }

  async loadSessions() {
    try {
      this.container.innerHTML = Array.from({length: 6}, () =>
        '<div class="session-skeleton"><div class="session-skeleton-title"></div><div class="session-skeleton-meta"></div></div>'
      ).join('');
      const res = await fetch('/api/sessions');
      const data = await res.json();
      this.projects = data.projects || [];
      this.render();
    } catch (error) {
      console.error('[Sidebar] Failed to load sessions:', error);
      this.container.innerHTML = '<div class="session-loading">Failed to load sessions</div>';
    }
  }

  setSearchQuery(query) {
    this.searchQuery = query.toLowerCase().trim();

    // Clear pending full-text search
    if (this._searchTimer) clearTimeout(this._searchTimer);

    if (!this.searchQuery) {
      this._searchResults = null;
      this.applySearch();
      return;
    }

    // Instant: filter titles
    this.applySearch();

    // Debounced: full-text search (300ms)
    if (this.searchQuery.length >= 2) {
      this._searchTimer = setTimeout(() => this.fullTextSearch(this.searchQuery), 300);
    }
  }

  async fullTextSearch(query) {
    // Don't search if query changed since debounce
    if (query !== this.searchQuery) return;

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (query !== this.searchQuery) return; // stale

      this._searchResults = data.results || [];
      this.renderSearchResults();
    } catch (err) {
      console.error('[Sidebar] Search failed:', err);
    }
  }

  renderSearchResults() {
    if (!this._searchResults || this._searchResults.length === 0) return;

    // Remove previous search results section
    const existing = this.container.querySelector('.search-results-group');
    if (existing) existing.remove();

    const group = document.createElement('div');
    group.className = 'search-results-group';

    const header = document.createElement('div');
    header.className = 'project-header search-results-header';
    header.innerHTML = `<span>🔍</span> <span>Message matches</span> <span class="project-count">${this._searchResults.length}</span>`;
    group.appendChild(header);

    const sessionsDiv = document.createElement('div');
    sessionsDiv.className = 'project-sessions';

    for (const result of this._searchResults) {
      const item = document.createElement('div');
      item.className = 'session-item search-result-item';
      item.dataset.filePath = result.filePath;
      if (result.project) item.dataset.projectPath = result.project;

      if (result.filePath === this.activeSessionFile) {
        item.classList.add('active');
      }

      const foreign = this.liveCwd && result.project && !pathsEqual(result.project, this.liveCwd);
      if (foreign) {
        item.classList.add('foreign-cwd');
        item.title = 'Other directory — read-only history';
      }

      const title = result.sessionName || result.firstMessage || 'Untitled';
      const snippet = result.matches[0]?.snippet || '';
      const matchCount = result.matches.length;
      const time = this.formatTime(result.sessionTimestamp);
      const roTag = foreign ? '<span class="session-tag ro-tag">RO</span>' : '';

      item.innerHTML = `
        <div class="session-title-row">
          <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
          ${roTag}
        </div>
        <div class="search-snippet">${this.highlightMatch(snippet, this.searchQuery)}</div>
        <div class="session-meta">${time}${matchCount > 1 ? ` · ${matchCount} matches` : ''}</div>
      `;

      // Find the matching project/session to pass to onSessionSelect
      item.addEventListener('click', () => {
        for (const project of this.projects) {
          const session = project.sessions.find(s => s.filePath === result.filePath);
          if (session) {
            this.onSessionSelect(session, project);
            return;
          }
        }
        // Session not in loaded list (unlikely) — try switching by path
        this.onSessionSelect({ filePath: result.filePath, name: result.sessionName }, { path: result.project });
      });

      sessionsDiv.appendChild(item);
    }

    group.appendChild(sessionsDiv);
    // Insert at top of container
    this.container.insertBefore(group, this.container.firstChild);
  }

  highlightMatch(text, query) {
    if (!query) return this.escapeHtml(text);
    const escaped = this.escapeHtml(text);
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(re, '<mark>$1</mark>');
  }

  applySearch() {
    if (!this.searchQuery) {
      this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('hidden'));
      this.container.querySelectorAll('.project-group').forEach(el => el.style.display = '');
      const favSection = this.container.querySelector('.favourites-group');
      if (favSection) favSection.style.display = '';
      // Remove full-text results
      const searchGroup = this.container.querySelector('.search-results-group');
      if (searchGroup) searchGroup.remove();
      return;
    }

    // Search favourites section
    const favSection = this.container.querySelector('.favourites-group');
    if (favSection) {
      let hasVisible = false;
      favSection.querySelectorAll('.session-item').forEach(item => {
        const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
        const matches = title.includes(this.searchQuery);
        item.classList.toggle('hidden', !matches);
        if (matches) hasVisible = true;
      });
      favSection.style.display = hasVisible ? '' : 'none';
    }

    this.container.querySelectorAll('.project-group').forEach(group => {
      let hasVisible = false;
      group.querySelectorAll('.session-item').forEach(item => {
        const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
        const matches = title.includes(this.searchQuery);
        item.classList.toggle('hidden', !matches);
        if (matches) hasVisible = true;
      });
      group.style.display = hasVisible ? '' : 'none';
    });
  }

  setActive(filePath) {
    this.activeSessionFile = filePath;
    this.container.querySelectorAll('.session-item').forEach(el => {
      el.classList.toggle('active', el.dataset.filePath === filePath);
    });
  }

  clearActive() {
    this.activeSessionFile = null;
    this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  }

  // ═══════════════════════════════════════
  // Context Menu
  // ═══════════════════════════════════════

  showContextMenu(e, session, project, itemEl) {
    e.preventDefault();
    this.closeContextMenu();

    const isFav = this.isFavourite(session.filePath);
    const menu = document.createElement('div');
    menu.className = 'session-context-menu';

    const items = [
      { icon: isFav ? '★' : '☆', label: isFav ? 'Unfavourite' : 'Favourite', action: () => this.toggleFavourite(session.filePath) },
      { icon: '✎', label: 'Rename', action: () => this.startRename(itemEl) },
      { icon: '📋', label: 'Export HTML', action: () => this.exportSession(session) },
      { icon: '🗑', label: 'Delete', action: () => this.deleteSession(session, itemEl) },
    ];

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'context-menu-item';
      row.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${item.label}`;
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.closeContextMenu();
        item.action();
      });
      menu.appendChild(row);
    }

    // Position
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    this.contextMenu = menu;
  }

  closeContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  startRename(itemEl) {
    const titleEl = itemEl.querySelector('.session-title');
    if (!titleEl) return;
    const currentName = titleEl.textContent;

    const input = document.createElement('input');
    input.className = 'session-rename-input';
    input.value = currentName;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        try {
          await fetch('/api/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'set_session_name', name: newName }),
          });
        } catch { /* silent */ }
      }
      const newTitle = document.createElement('div');
      newTitle.className = 'session-title';
      newTitle.title = newName || currentName;
      newTitle.textContent = newName || currentName;
      input.replaceWith(newTitle);
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
      if (ke.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  }

  async deleteSession(session, itemEl) {
    if (!confirm(`Delete "${session.name || session.firstMessage || 'this session'}"?`)) return;
    try {
      const res = await fetch('/api/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: session.filePath }),
      });
      if (res.ok) {
        itemEl.remove();
        // Remove from favourites if present
        const favIdx = this.favourites.indexOf(session.filePath);
        if (favIdx >= 0) {
          this.favourites.splice(favIdx, 1);
          this.saveFavourites();
        }
        // If this was the active session, clear it
        if (session.filePath === this.activeSessionFile) {
          this.clearActive();
          if (this.onSessionSelect) this.onSessionSelect(null, null);
        }
      }
    } catch (e) {
      console.error('[Sidebar] Delete failed:', e);
    }
  }

  async exportSession(session) {
    try {
      const data = await (await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'export_html' }),
      })).json();
      if (data?.success && data.data?.path) {
        window.open(`/api/sessions/${encodeURIComponent(data.data.path)}`);
      }
    } catch { /* silent */ }
  }

  // ═══════════════════════════════════════
  // Render
  // ═══════════════════════════════════════

  buildSessionItem(session, project) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.filePath = session.filePath;
    if (project?.path) item.dataset.projectPath = project.path;

    if (session.filePath === this.activeSessionFile) {
      item.classList.add('active');
    }

    const foreign = !this.isSameCwdProject(project);
    if (foreign) {
      item.classList.add('foreign-cwd');
      item.title = 'Other directory — read-only history (live switch only for current cwd)';
    }

    const title = session.name || session.firstMessage || 'Empty session';
    const time = this.formatTime(session.timestamp);
    const tmuxTag = session.tmux ? '<span class="session-tag tmux-tag">tmux</span>' : '';
    const favIcon = this.isFavourite(session.filePath) ? '<span class="session-fav-icon">★</span>' : '';
    const roTag = foreign ? '<span class="session-tag ro-tag" title="Read-only">RO</span>' : '';

    item.innerHTML = `
      <div class="session-title-row">
        ${favIcon}
        <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        ${tmuxTag}
        ${roTag}
      </div>
      <div class="session-meta">${time}</div>
    `;

    item.addEventListener('click', () => this.onSessionSelect(session, project));
    item.addEventListener('contextmenu', (e) => this.showContextMenu(e, session, project, item));

    return item;
  }

  render() {
    if (this.projects.length === 0) {
      this.container.innerHTML = '<div class="session-loading">No sessions found</div>';
      return;
    }

    this.container.innerHTML = '';

    // Favourites section — collect from all projects
    const favSessions = [];
    for (const project of this.projects) {
      for (const session of project.sessions) {
        if (this.isFavourite(session.filePath)) {
          favSessions.push({ session, project });
        }
      }
    }

    if (favSessions.length > 0) {
      const favGroup = document.createElement('div');
      favGroup.className = 'favourites-group';

      const header = document.createElement('div');
      header.className = 'project-header favourites-header';
      header.innerHTML = `<span class="fav-star">★</span> <span>Favourites</span> <span class="project-count">${favSessions.length}</span>`;
      favGroup.appendChild(header);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'project-sessions';
      for (const { session, project } of favSessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project));
      }
      favGroup.appendChild(sessionsDiv);
      this.container.appendChild(favGroup);
    }

    // Regular project groups — current cwd first, then foreign (read-only)
    const sortedProjects = [...this.projects].sort((a, b) => {
      const aSame = this.isSameCwdProject(a) ? 0 : 1;
      const bSame = this.isSameCwdProject(b) ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      return 0;
    });

    for (const project of sortedProjects) {
      const group = document.createElement('div');
      const foreign = !this.isSameCwdProject(project);
      group.className = `project-group${foreign ? ' foreign-cwd' : ''}`;
      if (project.path) group.dataset.projectPath = project.path;
      const isCollapsed = this.collapsedProjects.has(project.dirName);

      const header = document.createElement('div');
      header.className = `project-header${isCollapsed ? ' collapsed' : ''}`;

      const pathParts = project.path.replace(/\\/g, '/').split('/').filter(Boolean);
      const shortPath = pathParts.length > 0 ? pathParts[pathParts.length - 1] : project.path;
      const roLabel = foreign ? '<span class="project-ro-label">read-only</span>' : '';

      header.innerHTML = `
        <span class="chevron">▼</span>
        <span title="${this.escapeHtml(project.path)}">${this.escapeHtml(shortPath)}</span>
        ${roLabel}
        <span class="project-count">${project.sessions.length}</span>
      `;

      header.addEventListener('click', () => {
        if (this.collapsedProjects.has(project.dirName)) {
          this.collapsedProjects.delete(project.dirName);
        } else {
          this.collapsedProjects.add(project.dirName);
        }
        header.classList.toggle('collapsed');
        sessionsDiv.classList.toggle('collapsed');
      });

      group.appendChild(header);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = `project-sessions${isCollapsed ? ' collapsed' : ''}`;

      for (const session of project.sessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project));
      }

      group.appendChild(sessionsDiv);
      this.container.appendChild(group);
    }

    if (this.searchQuery) this.applySearch();
    this.applyForeignCwdStyles();
  }

  formatTime(isoTimestamp) {
    try {
      const date = new Date(isoTimestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const days = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (days === 1) return 'Yesterday';
      if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
