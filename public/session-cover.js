/**
 * Session cover (Session Prologue)
 * Classic pixel-π mark + "PI Agent" title.
 */

export const sessionCoverState = {
  metadata: null,
  visible: true,
  animationPlayed: false,
};

/**
 * Classic app-icon π (user-approved shape earlier):
 * top bar, two legs, right foot, left leg slightly longer.
 */
function piMarkSvg() {
  const rows = [
    'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    '..XXXXXXXXXXXXXXXXXXXXXXXXXXXX..',
    '....XXXXXX............XXXXXX....',
    '....XXXXXX............XXXXXX....',
    '....XXXXXX............XXXXXX....',
    '....XXXXXX............XXXXXX....',
    '....XXXXXX............XXXXXX....',
    '....XXXXXX............XXXXXX....',
    '....XXXXXX............XXXXXX....',
    '....XXXXXX............XXXXXX....',
    '..XXXXXXXXXX........XXXXXXXXXX..',
    '..XXXXXXXXXX........XXXXXXXXXX..',
  ];

  const cells = [];
  let maxX = 0;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === 'X') {
        cells.push([x, y]);
        if (x > maxX) maxX = x;
      }
    }
  }

  const w = maxX + 1;
  const h = rows.length;
  const yScale = 2.0;
  const uid = `pi${Math.random().toString(36).slice(2, 8)}`;
  const rects = cells
    .map(
      ([x, y]) =>
        `<rect x="${x}" y="${(y * yScale).toFixed(3)}" width="1" height="${yScale}" fill="url(#${uid})"/>`
    )
    .join('');
  const vh = h * yScale;

  return `
    <svg class="session-cover__pi" viewBox="0 0 ${w} ${vh}" width="48" height="80" aria-hidden="true" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="${uid}" x1="0" y1="0" x2="${w}" y2="${vh}" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#f0abfc"/>
          <stop offset="40%" stop-color="#a78bfa"/>
          <stop offset="100%" stop-color="#22d3ee"/>
        </linearGradient>
      </defs>
      ${rects}
    </svg>`;
}

function row(label, value) {
  if (value == null || value === '') return '';
  const i = row._i++;
  return `<div class="session-cover__row" style="--i:${i}">
    <dt>${label}</dt>
    <dd>${escapeHtml(String(value))}</dd>
  </div>`;
}
row._i = 0;

export function createSessionCover(slot, metadata, options = {}) {
  if (!slot) return;
  sessionCoverState.metadata = metadata;
  if (options.visible === false || sessionCoverState.visible === false) {
    slot.innerHTML = '';
    return;
  }
  render(slot, metadata, options);
}

export function updateSessionCover(slot, patch) {
  if (!slot) return;
  sessionCoverState.metadata = { ...(sessionCoverState.metadata || {}), ...patch };
  render(slot, sessionCoverState.metadata, { animate: false });
}

export function setSessionCoverVisibility(slot, visible) {
  sessionCoverState.visible = visible;
  if (!visible) {
    slot.innerHTML = '';
  } else if (sessionCoverState.metadata) {
    render(slot, sessionCoverState.metadata, { animate: false });
  }
}

export function replaySessionCoverAnimation(slot) {
  sessionCoverState.animationPlayed = false;
  if (sessionCoverState.metadata) {
    render(slot, sessionCoverState.metadata, { animate: true });
  }
}

function render(slot, meta, options = {}) {
  if (!meta) {
    slot.innerHTML = '';
    return;
  }
  row._i = 0;
  const animate = options.animate !== false && !sessionCoverState.animationPlayed;
  const m = meta.model;
  const modelLabel = m
    ? [m.provider, m.displayName || m.id].filter(Boolean).join(' / ')
    : null;

  let contextLabel = null;
  if (meta.contextUsage) {
    const { tokens, contextWindow, percent } = meta.contextUsage;
    if (percent != null) {
      contextLabel = `${percent}%${tokens != null && contextWindow != null ? ` · ${fmt(tokens)} / ${fmt(contextWindow)}` : ''}`;
    } else if (tokens != null && contextWindow != null) {
      contextLabel = `${fmt(tokens)} / ${fmt(contextWindow)}`;
    }
  }

  let loaded = null;
  if (meta.resources) {
    const { extensions = 0, prompts = 0, skills = 0 } = meta.resources;
    loaded = `${extensions} ext · ${prompts} prompts · ${skills} skills`;
  }

  let gitLabel = null;
  if (meta.git?.branch) {
    gitLabel = `${meta.git.branch}${meta.git.dirty ? ' · dirty' : ' · clean'}`;
  }

  let runtime = null;
  if (meta.runtime) {
    const parts = [];
    if (meta.runtime.piVersion) parts.push(`Pi ${meta.runtime.piVersion}`);
    if (meta.runtime.tauVersion) parts.push(`Tau ${meta.runtime.tauVersion}`);
    runtime = parts.join(' · ') || null;
  }

  const rows = [
    row('SESSION', meta.sessionName || 'Untitled'),
    row('PROJECT', meta.projectName || (meta.cwd ? basename(meta.cwd) : null)),
    row('MODEL', modelLabel),
    row('THINKING', meta.thinkingLevel || null),
    row('CONTEXT', contextLabel),
    row('RUNTIME', runtime),
    row('BRANCH', gitLabel),
    row('LOADED', loaded),
  ].join('');

  slot.innerHTML = `
    <section class="session-cover${animate ? ' session-cover--animate' : ''}" aria-label="Pi session information">
      <div class="session-cover__glow" aria-hidden="true"></div>
      <div class="session-cover__hero">
        <div class="session-cover__logo-wrap" aria-hidden="true">
          ${piMarkSvg()}
        </div>
        <div class="session-cover__brand">
          <div class="session-cover__kicker">CODING AGENT</div>
          <h1 class="session-cover__title">
            <span class="session-cover__title-pi">PI</span><span class="session-cover__title-agent">Agent</span>
          </h1>
          <div class="session-cover__subtitle">Same session · terminal &amp; browser in sync</div>
        </div>
      </div>
      <div class="session-cover__rule"></div>
      <dl class="session-cover__meta">${rows}</dl>
      <div class="session-cover__hint">
        Type <kbd>/</kbd> for Pi commands
        <span class="session-cover__hint-sep">·</span>
        <span class="session-cover__hint-soft">Sidebar switches the live Pi session</span>
      </div>
    </section>
  `;

  if (animate) {
    sessionCoverState.animationPlayed = true;
  }
}

function basename(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

function fmt(n) {
  const x = Number(n);
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`;
  if (x >= 1_000) return `${(x / 1_000).toFixed(1)}k`;
  return String(x);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
