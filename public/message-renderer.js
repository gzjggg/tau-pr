/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { renderMarkdown, renderUserMarkdown } from './markdown.js';

export class MessageRenderer {
  /**
   * @param {HTMLElement} container - message list (#messages)
   * @param {{ scrollRoot?: HTMLElement }} [options] - actual overflow scroller (#messages-scroll)
   */
  constructor(container, options = {}) {
    this.container = container;
    this.scrollRoot = options.scrollRoot || container;
    this.isNearBottom = true;

    // Track scroll on the real scroll parent (not the flex child)
    this.scrollRoot.addEventListener('scroll', () => {
      const threshold = 120;
      const el = this.scrollRoot;
      this.isNearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    }, { passive: true });
  }

  clear() {
    this.container.innerHTML = '';
  }

  /**
   * Render KaTeX math in the given element if the library is loaded.
   * Safe to call on streaming/escaped content — KaTeX only processes $...$ patterns.
   */
  _renderMath(element) {
    if (typeof renderMathInElement !== 'undefined') {
      try {
        renderMathInElement(element, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch (e) {
        // KaTeX not loaded or rendering failed — math stays as raw TeX
      }
    }
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/tau-192.png" alt="τ" class="tau-icon-welcome"></div>
        <p>Welcome to Tau</p>
        <p class="hint">Type a message below to start chatting with Pi, or select a session from the sidebar.</p>
        <div class="shortcuts-hint">
          <span>/ Focus input</span>
          <span>Esc Abort</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const raw = typeof message.content === 'string' ? message.content : '';
    const slashInfo = parseSlashUserMessage(raw);

    const div = document.createElement('div');
    let extraClass = '';
    if (slashInfo) {
      extraClass = slashInfo.isSkill ? ' skill-cmd' : ' slash-cmd';
    }
    div.className = `message user${extraClass}${isHistory ? ' history' : ''}`;

    let imagesHtml = '';
    if (message.images && message.images.length > 0) {
      imagesHtml = '<div class="message-images">' +
        message.images.map(img => {
          const src = img.data.startsWith('data:') ? img.data : `data:${img.mimeType || 'image/png'};base64,${img.data}`;
          return `<img class="message-image" src="${src}" alt="Attached image" />`;
        }).join('') +
        '</div>';
    }

    let bodyHtml;
    if (slashInfo) {
      const argsHtml = slashInfo.args
        ? ` <span class="slash-cmd-args">${escapeHtmlText(slashInfo.args)}</span>`
        : '';
      bodyHtml = `<span class="slash-cmd-name">${escapeHtmlText(slashInfo.invocation)}</span>${argsHtml}`;
    } else {
      bodyHtml = renderUserMarkdown(message.content);
    }

    div.innerHTML = `
      <div class="message-content">${imagesHtml}${bodyHtml}</div>
      <button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    `;
    this._setupCopyBtn(div);
    this.container.appendChild(div);
    this._renderMath(div);
    if (!isHistory) this.scrollToBottom();
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message assistant${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message.id || 'streaming';

    let contentHtml = '';
    let usageHtml = '';

    if (typeof message.content === 'string') {
      contentHtml = isStreaming ? this.escapeHtml(message.content) : renderMarkdown(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          contentHtml += isStreaming ? this.escapeHtml(block.text) : renderMarkdown(block.text);
        } else if (block.type === 'thinking') {
          contentHtml += this.renderThinkingBlock(block.thinking);
        }
      }
    }

    // Usage/cost info
    if (message.usage && message.usage.cost) {
      const cost = message.usage.cost.total;
      if (cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }

    const streamingClass = isStreaming ? ' streaming' : '';

    div.innerHTML = `
      <div class="message-content${streamingClass}">${contentHtml}</div>
      ${usageHtml}
      ${!isStreaming ? '<button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' : ''}
    `;

    if (!isStreaming) {
      this._setupCopyBtn(div);
    }
    this.container.appendChild(div);
    if (!isStreaming) this._renderMath(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking) {
    const id = 'thinking-' + Math.random().toString(36).slice(2, 8);
    return `<div class="thinking-block">
<div class="thinking-toggle" onclick="var c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded')">
<span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
<span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> Thinking</span>
</div>
<div class="thinking-content" id="${id}">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  updateStreamingThinking(messageElement, thinking) {
    let thinkingDiv = messageElement.querySelector('.streaming-thinking');
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector('.message-content');
      if (!contentDiv) return;
      thinkingDiv = document.createElement('div');
      thinkingDiv.className = 'thinking-block streaming-thinking';
      thinkingDiv.innerHTML = `
        <div class="thinking-toggle expanded" onclick="var c=this.nextElementSibling;c.classList.toggle('expanded');this.classList.toggle('expanded')">
          <span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> Thinking</span>
        </div>
        <div class="thinking-content expanded"></div>`;
      contentDiv.prepend(thinkingDiv);
    }
    const contentEl = thinkingDiv.querySelector('.thinking-content');
    if (contentEl) {
      contentEl.textContent = thinking;
      this.scrollToBottom();
    }
  }

  updateStreamingMessage(messageElement, content) {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      // Keep any thinking block, update only the text part
      const thinkingBlock = contentDiv.querySelector('.streaming-thinking');
      const escaped = this.escapeHtml(content);
      if (thinkingBlock) {
        // Remove everything after the thinking block and re-add text
        let textNode = contentDiv.querySelector('.streaming-text');
        if (!textNode) {
          textNode = document.createElement('div');
          textNode.className = 'streaming-text';
          contentDiv.appendChild(textNode);
        }
        textNode.innerHTML = escaped;
      } else {
        contentDiv.innerHTML = escaped;
      }
      this.scrollToBottom();
    }
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = '') {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.classList.remove('streaming');
      // Get the raw text (exclude thinking block text)
      const streamingText = contentDiv.querySelector('.streaming-text');
      const rawText = streamingText ? streamingText.textContent : contentDiv.textContent;
      
      // Rebuild with thinking block (if any) + markdown text
      let html = '';
      if (thinking) {
        html += this.renderThinkingBlock(thinking);
      }
      html += renderMarkdown(rawText);
      contentDiv.innerHTML = html;
      // Render math after markdown is applied
      this._renderMath(contentDiv);
    }

    // Add copy button after streaming finishes
    if (!messageElement.querySelector('.message-copy-btn')) {
      const btn = document.createElement('button');
      btn.className = 'message-copy-btn';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      messageElement.appendChild(btn);
      this._setupCopyBtn(messageElement);
    }

    // Add usage info if available
    if (usage && usage.cost && usage.cost.total > 0) {
      if (!messageElement.querySelector('.message-usage')) {
        const span = document.createElement('span');
        span.className = 'message-usage';
        span.textContent = `$${usage.cost.total.toFixed(4)}`;
        messageElement.appendChild(span);
      }
    }
  }

  renderSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = text;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = `⚠️ ${errorMessage}`;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector('.message-copy-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const content = messageEl.querySelector('.message-content');
      if (!content) return;
      const text = content.textContent;
      // Fallback for non-HTTPS (LAN access)
      const copyText = (t) => {
        if (navigator.clipboard) return navigator.clipboard.writeText(t);
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve();
      };
      copyText(text).then(() => {
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom(force = false) {
    if (!force && !this.isNearBottom) return;
    const el = this.scrollRoot;
    const jump = () => { el.scrollTop = el.scrollHeight; };
    requestAnimationFrame(() => {
      jump();
      requestAnimationFrame(jump);
    });
    this.isNearBottom = true;
  }
}

/** Detect `/command` or `/skill:name` user invocations for accent styling */
function parseSlashUserMessage(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  // Single-line or first-line slash command
  const firstLine = trimmed.split(/\n/)[0].trim();
  const m = firstLine.match(/^(\/[\w.:-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  // Only treat whole message as command if it's short / clearly a slash invoke
  if (trimmed.includes('\n') && trimmed.length > 200) return null;
  const invocation = m[1];
  const args = (m[2] || '').trim();
  // Skills: /skill:name or common skill entrypoints like /websearch
  const isSkill =
    invocation.startsWith('/skill:') ||
    /^\/(websearch|web-search)$/i.test(invocation);
  return {
    invocation,
    args: trimmed.includes('\n') ? trimmed.slice(invocation.length).trim() : args,
    isSkill,
  };
}

function escapeHtmlText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
