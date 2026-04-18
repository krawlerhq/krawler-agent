// Settings page JS. Scope is deliberately narrow:
//   - paste the Krawler agent key (or disconnect / copy)
//   - pick a model provider + key, or Ollama base URL
//   - pick a cadence + dry-run flag
//   - show a read-only identity header fetched from krawler.com /me
//
// Everything else (identity claim, feed, post, start/pause, activity log)
// lives on krawler.com or in the `krawler` CLI.
//
// Key rules (hard-learned):
//   - Never wipe a form input on save or on provider change. Ever.
//   - Secrets get a reveal toggle (password/text) AND a masked preview after save.
//   - Polling updates identity only. Never touches inputs the user might be editing.

const $ = (id) => document.getElementById(id);

const PROVIDER_FIELDS = {
  anthropic: {
    label: 'Anthropic API key',
    stateKey: 'hasAnthropicApiKey',
    maskedKey: 'anthropicApiKeyMasked',
    patchKey: 'anthropicApiKey',
    secret: true,
    placeholder: 'sk-ant-…',
    hint: 'Stored in <code>~/.config/krawler-agent/config.json</code> (0600). Only sent to api.anthropic.com.',
  },
  openai: {
    label: 'OpenAI API key',
    stateKey: 'hasOpenaiApiKey',
    maskedKey: 'openaiApiKeyMasked',
    patchKey: 'openaiApiKey',
    secret: true,
    placeholder: 'sk-…',
    hint: 'Stored in <code>~/.config/krawler-agent/config.json</code> (0600). Only sent to api.openai.com.',
  },
  google: {
    label: 'Google AI API key',
    stateKey: 'hasGoogleApiKey',
    maskedKey: 'googleApiKeyMasked',
    patchKey: 'googleApiKey',
    secret: true,
    placeholder: 'AIza…',
    hint: 'Get one at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>.',
  },
  openrouter: {
    label: 'OpenRouter API key',
    stateKey: 'hasOpenrouterApiKey',
    maskedKey: 'openrouterApiKeyMasked',
    patchKey: 'openrouterApiKey',
    secret: true,
    placeholder: 'sk-or-…',
    hint: 'One key, many models. Model names look like <code>anthropic/claude-opus-4-7</code>.',
  },
  ollama: {
    label: 'Ollama base URL',
    stateKey: null,
    maskedKey: null,
    patchKey: 'ollamaBaseUrl',
    secret: false,
    placeholder: 'http://localhost:11434',
    hint: 'Runs models locally. No API key required. <a href="https://ollama.com" target="_blank">ollama.com</a>.',
  },
};

let currentConfig = null;
let modelSuggestions = {};
let runtimeHydrated = false;
const editMode = new Set();

async function fetchConfig({ hydrateRuntime } = { hydrateRuntime: false }) {
  const r = await fetch('/api/config');
  const j = await r.json();
  currentConfig = j.config;
  modelSuggestions = j.modelSuggestions ?? {};
  if (hydrateRuntime && !runtimeHydrated) {
    hydrateRuntimeFromConfig();
    runtimeHydrated = true;
  }
  renderCredField();
  renderKrawlerKeyField();
}

function hydrateRuntimeFromConfig() {
  $('provider').value = currentConfig.provider;
  $('model').value = currentConfig.model ?? '';
  $('cadence').value = String(currentConfig.cadenceMinutes);
  $('dry-run').checked = currentConfig.dryRun;
  renderModelSuggestions();
}

// ───────────────────────── Identity header ─────────────────────────

async function fetchIdentity() {
  const host = $('identity');
  try {
    const r = await fetch('/api/me');
    const j = await r.json();
    renderIdentity(j);
  } catch (e) {
    host.className = 'identity empty';
    host.textContent = `krawler.com unreachable: ${e.message}`;
  }
}

function renderIdentity(s) {
  const host = $('identity');
  if (!s.agent) {
    host.className = 'identity empty';
    if (s.reason === 'no-key') {
      host.textContent = 'No Krawler key yet. Paste one below to bind this install to an agent.';
    } else {
      host.textContent = `Could not reach krawler.com: ${s.reason ?? 'unknown error'}`;
    }
    return;
  }
  const a = s.agent;
  const avatarUrl = `https://api.dicebear.com/9.x/${encodeURIComponent(a.avatarStyle || 'bottts')}/svg?seed=${encodeURIComponent(a.handle)}`;
  const lastHb = currentConfig?.lastHeartbeat
    ? `last heartbeat: ${new Date(currentConfig.lastHeartbeat).toLocaleString()}`
    : 'no heartbeat yet';

  if (s.placeholderHandle) {
    host.className = 'identity placeholder';
    host.innerHTML = `
      <img class="avatar" src="${avatarUrl}" alt="@${escapeAttr(a.handle)}" />
      <div class="meta">
        <div class="handle">@${escapeHtml(a.handle)} <small>(placeholder)</small></div>
        <div class="display">Claim a real handle at <a href="https://krawler.com/dashboard/" target="_blank">krawler.com/dashboard</a> before starting the heartbeat loop.</div>
      </div>
    `;
    return;
  }

  host.className = 'identity';
  host.innerHTML = `
    <img class="avatar" src="${avatarUrl}" alt="@${escapeAttr(a.handle)}" />
    <div class="meta">
      <div class="handle">@${escapeHtml(a.handle)}</div>
      <div class="display">${escapeHtml(a.displayName || '')}</div>
      <div class="hb">${escapeHtml(lastHb)}</div>
    </div>
    <a class="manage" href="https://krawler.com/dashboard/" target="_blank">Manage ↗</a>
  `;
}

// ───────────────────────── Key fields ─────────────────────────

function renderCredField() {
  if (!currentConfig) return;
  const provider = $('provider').value;
  const def = PROVIDER_FIELDS[provider];
  const host = $('cred-field');

  if (!def.secret) {
    const existing = $('cred-input');
    const seed = existing ? existing.value : currentConfig.ollamaBaseUrl ?? '';
    host.innerHTML = `
      <label>${def.label}</label>
      <input id="cred-input" type="url" placeholder="${def.placeholder}" value="${escapeAttr(seed)}" autocomplete="off" spellcheck="false" />
      <div class="hint">${def.hint}</div>
    `;
    return;
  }

  const hasKey = currentConfig[def.stateKey];
  const masked = currentConfig[def.maskedKey] ?? '';
  const editing = editMode.has(provider);

  if (hasKey && !editing) {
    host.innerHTML = `
      <label>${def.label} <small class="muted ok">(saved)</small></label>
      <div class="masked-preview">
        <span>${escapeHtml(masked)}</span>
        <button type="button" class="edit-btn" data-cred-edit="${provider}">Replace</button>
      </div>
      <div class="hint">${def.hint}</div>
    `;
    host.querySelector('[data-cred-edit]').addEventListener('click', () => {
      editMode.add(provider);
      renderCredField();
      requestAnimationFrame(() => $('cred-input')?.focus());
    });
    return;
  }

  const existing = $('cred-input');
  const existingValue = existing ? existing.value : '';
  host.innerHTML = `
    <label>${def.label} <small class="muted">${hasKey ? '(replacing saved key)' : '(not set)'}</small></label>
    <div class="key-input">
      <input id="cred-input" type="password" placeholder="${def.placeholder}" value="${escapeAttr(existingValue)}" autocomplete="off" spellcheck="false" />
      <button type="button" class="reveal" data-cred-toggle>Show</button>
    </div>
    <div class="hint">${def.hint}</div>
  `;
  wireRevealToggle(host.querySelector('[data-cred-toggle]'), $('cred-input'));
}

function renderKrawlerKeyField() {
  if (!currentConfig) return;
  const host = $('krawler-key-wrap');
  const hasKey = currentConfig.hasKrawlerApiKey;
  const masked = currentConfig.krawlerApiKeyMasked ?? '';
  const editing = editMode.has('krawler');

  if (hasKey && !editing) {
    host.innerHTML = `
      <label>Agent key <small class="muted ok">(saved)</small></label>
      <div class="masked-preview">
        <span>${escapeHtml(masked)}</span>
        <button type="button" class="edit-btn" data-krawler-edit>Replace</button>
        <button type="button" class="copy-btn" data-krawler-copy>Copy</button>
        <button type="button" class="danger-btn" data-krawler-disconnect>Disconnect</button>
      </div>
      <span id="krawler-save-status" class="muted" style="margin-left: 8px;"></span>
    `;
    host.querySelector('[data-krawler-edit]').addEventListener('click', () => {
      editMode.add('krawler');
      renderKrawlerKeyField();
      requestAnimationFrame(() => $('krawler-input')?.focus());
    });
    host.querySelector('[data-krawler-copy]').addEventListener('click', copyKrawlerKey);
    host.querySelector('[data-krawler-disconnect]').addEventListener('click', disconnectKrawlerKey);
    return;
  }

  const existing = $('krawler-input');
  const existingValue = existing ? existing.value : '';
  host.innerHTML = `
    <label>Agent key <small class="muted">${hasKey ? '(replacing)' : '(not set)'}</small></label>
    <div class="key-input">
      <input id="krawler-input" type="password" placeholder="kra_live_…" value="${escapeAttr(existingValue)}" autocomplete="off" spellcheck="false" />
      <button type="button" class="reveal" data-krawler-toggle>Show</button>
    </div>
    <div class="row" style="margin-top: 8px;">
      <button id="btn-save-krawler">Save key</button>
      <span id="krawler-save-status" class="muted"></span>
    </div>
  `;
  wireRevealToggle(host.querySelector('[data-krawler-toggle]'), $('krawler-input'));
  $('btn-save-krawler').addEventListener('click', saveKrawlerKey);
}

function wireRevealToggle(btn, input) {
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      btn.textContent = 'Show';
    }
  });
}

function renderModelSuggestions() {
  const provider = $('provider').value;
  const dl = $('model-suggestions');
  const list = modelSuggestions[provider] ?? [];
  dl.innerHTML = list.map((m) => `<option value="${escapeAttr(m)}"></option>`).join('');
}

// ───────────────────────── Save actions ─────────────────────────

function collectRuntimePatch() {
  const provider = $('provider').value;
  const patch = {
    provider,
    model: $('model').value.trim(),
    cadenceMinutes: Number($('cadence').value),
    dryRun: $('dry-run').checked,
  };
  const def = PROVIDER_FIELDS[provider];
  const credEl = $('cred-input');
  if (credEl) {
    const credVal = credEl.value;
    if (credVal) patch[def.patchKey] = credVal;
  }
  return patch;
}

async function saveRuntime() {
  const status = $('save-status');
  setStatus(status, 'saving…');
  try {
    const patch = collectRuntimePatch();
    const r = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    const j = await r.json();
    currentConfig = j.config;
    const provider = $('provider').value;
    const def = PROVIDER_FIELDS[provider];
    if (def.secret && currentConfig[def.stateKey]) {
      editMode.delete(provider);
    }
    renderCredField();
    setStatus(status, 'saved ✓', 'ok', 2000);
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
  }
}

async function saveKrawlerKey() {
  const status = $('krawler-save-status');
  const val = $('krawler-input')?.value ?? '';
  if (!val) {
    setStatus(status, 'paste a key first', 'warn', 2000);
    return;
  }
  setStatus(status, 'saving…');
  try {
    const r = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ krawlerApiKey: val }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    const j = await r.json();
    currentConfig = j.config;
    editMode.delete('krawler');
    renderKrawlerKeyField();
    fetchIdentity();
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
  }
}

async function copyKrawlerKey() {
  const status = $('krawler-save-status');
  try {
    const r = await fetch('/api/agent/reveal-key');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { key } = await r.json();
    await navigator.clipboard.writeText(key);
    setStatus(status, 'copied ✓', 'ok', 2000);
  } catch (e) {
    setStatus(status, `copy failed: ${e.message}`, 'err');
  }
}

async function disconnectKrawlerKey() {
  if (!confirm('Disconnect this install? Your agent on krawler.com is untouched; you can paste the key again any time.')) return;
  const status = $('krawler-save-status');
  setStatus(status, 'disconnecting…');
  try {
    const r = await fetch('/api/agent', { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    currentConfig = j.config;
    editMode.delete('krawler');
    renderKrawlerKeyField();
    fetchIdentity();
    setStatus(status, 'disconnected', 'ok', 2000);
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
  }
}

// ───────────────────────── Helpers ─────────────────────────

function setStatus(el, text, kind = 'muted', autoClearMs = 0) {
  if (!el) return;
  el.textContent = text;
  el.className = 'muted ' + kind;
  if (autoClearMs) {
    setTimeout(() => {
      if (el.textContent === text) {
        el.textContent = '';
        el.className = 'muted';
      }
    }, autoClearMs);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ───────────────────────── Wiring ─────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  $('provider').addEventListener('change', () => {
    renderCredField();
    renderModelSuggestions();
    const suggestions = modelSuggestions[$('provider').value] ?? [];
    const current = $('model').value.trim();
    if (!current && suggestions[0]) $('model').value = suggestions[0];
  });

  $('btn-save').addEventListener('click', saveRuntime);

  fetchConfig({ hydrateRuntime: true }).then(fetchIdentity);

  setInterval(() => { fetchConfig().catch(() => {}); }, 15000);
  setInterval(fetchIdentity, 30000);
});
