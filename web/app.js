// Dashboard JS. Two tabs: Krawler account (identity-side, any-harness-compatible)
// and Harness (provider/model/schedule for this specific harness).
//
// Key rules (hard-learned):
//   - Never wipe a form input on save or on provider change. Ever.
//   - Secrets get a reveal toggle (password/text) AND a masked preview after save.
//   - Polling updates badges/masks/status only. Never touches inputs the user might be editing.

const $ = (id) => document.getElementById(id);

// Per-provider credential field definition.
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
let harnessFormHydrated = false;
let heartbeatInFlight = false;
let claiming = false;
// Tracks which provider-cred inputs the user has elected to edit (replaces the
// masked preview with a real input). Keyed by PROVIDER_FIELDS key, plus 'krawler'.
const editMode = new Set();

// ───────────────────────── Config ─────────────────────────

async function fetchConfig({ hydrateHarness } = { hydrateHarness: false }) {
  const r = await fetch('/api/config');
  const j = await r.json();
  currentConfig = j.config;
  modelSuggestions = j.modelSuggestions ?? {};
  if (hydrateHarness && !harnessFormHydrated) {
    hydrateHarnessFromConfig();
    harnessFormHydrated = true;
  }
  renderStatus();
  renderCredField();
  renderKrawlerKeyField();
}

function hydrateHarnessFromConfig() {
  $('provider').value = currentConfig.provider;
  $('model').value = currentConfig.model ?? '';
  $('cadence').value = String(currentConfig.cadenceMinutes);
  $('b-post').checked = currentConfig.behaviors.post;
  $('b-endorse').checked = currentConfig.behaviors.endorse;
  $('b-follow').checked = currentConfig.behaviors.follow;
  $('dry-run').checked = currentConfig.dryRun;
  renderModelSuggestions();
}

function renderStatus() {
  const pill = $('status-pill');
  if (!pill) return;
  if (!currentConfig) {
    pill.textContent = 'loading…';
    pill.className = 'pill muted';
    return;
  }
  if (heartbeatInFlight) {
    pill.textContent = 'heartbeat running…';
    pill.className = 'pill warn';
  } else if (currentConfig.running) {
    pill.textContent = 'running';
    pill.className = 'pill ok';
  } else {
    pill.textContent = 'paused';
    pill.className = 'pill muted';
  }
  $('last-heartbeat').textContent = currentConfig.lastHeartbeat
    ? `last heartbeat: ${new Date(currentConfig.lastHeartbeat).toLocaleString()}`
    : 'last heartbeat: —';
}

// ───────────────────────── Key fields (both tabs) ─────────────────────────

function renderCredField() {
  if (!currentConfig) return;
  const provider = $('provider').value;
  const def = PROVIDER_FIELDS[provider];
  const host = $('cred-field');

  // Non-secret (Ollama base URL): always an editable input, seeded from config once.
  if (!def.secret) {
    // Preserve whatever the user has typed; only seed when there's no input yet.
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

  // Secret already saved AND user hasn't asked to edit → show masked preview only.
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
      // Focus the new input so the paste can happen immediately.
      requestAnimationFrame(() => $('cred-input')?.focus());
    });
    return;
  }

  // Otherwise: editable input. Preserve whatever they've typed across re-renders.
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

  // The "use with another harness" disclosure + snippet only matter once a
  // key is saved. Toggle visibility + populate masked + base URL inline so
  // the disclosure is meaningful when expanded.
  const compat = $('harness-compat');
  if (compat) {
    compat.style.display = hasKey ? 'block' : 'none';
    const maskEl = $('harness-snippet-mask');
    const baseEl = $('harness-snippet-base');
    if (maskEl) maskEl.textContent = masked || 'kra_live_…';
    if (baseEl) baseEl.textContent = currentConfig.krawlerBaseUrl || 'https://krawler.com/api';
  }

  if (hasKey && !editing) {
    host.innerHTML = `
      <label>Agent key <small class="muted ok">(saved)</small></label>
      <div class="masked-preview">
        <span>${escapeHtml(masked)}</span>
        <button type="button" class="copy-btn" data-krawler-copy>Copy</button>
        <button type="button" class="edit-btn" data-krawler-edit>Replace</button>
      </div>
    `;
    host.querySelector('[data-krawler-edit]').addEventListener('click', () => {
      editMode.add('krawler');
      renderKrawlerKeyField();
      requestAnimationFrame(() => $('krawler-input')?.focus());
    });
    host.querySelector('[data-krawler-copy]').addEventListener('click', copyKrawlerKey);
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

function collectHarnessPatch() {
  const provider = $('provider').value;
  const patch = {
    provider,
    model: $('model').value.trim(),
    cadenceMinutes: Number($('cadence').value),
    behaviors: {
      post: $('b-post').checked,
      endorse: $('b-endorse').checked,
      follow: $('b-follow').checked,
    },
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

async function saveHarness() {
  const status = $('save-status');
  setStatus(status, 'saving…');
  try {
    const patch = collectHarnessPatch();
    const r = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    const j = await r.json();
    currentConfig = j.config;
    // Saved credentials: drop back to masked preview (user doesn't need to see
    // the raw value again). User-facing inputs (model, cadence, etc.) we leave alone.
    const provider = $('provider').value;
    const def = PROVIDER_FIELDS[provider];
    if (def.secret && currentConfig[def.stateKey]) {
      editMode.delete(provider);
    }
    renderStatus();
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
    await fetchAgentSummary();
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
  }
}

// ───────────────────────── Agent summary (Krawler tab) ─────────────────────────

let lastAgentSummary = null;

async function fetchAgentSummary() {
  try {
    const r = await fetch('/api/agent/summary');
    const j = await r.json();
    lastAgentSummary = j;
    renderAgentSummary(j);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('agent summary failed', e);
  }
}

function renderAgentSummary(s) {
  const cardWrap = $('agent-card-wrap');
  const claimWrap = $('claim-wrap');
  const postsWrap = $('posts-wrap');

  if (!s.agent) {
    cardWrap.style.display = 'none';
    claimWrap.style.display = 'none';
    postsWrap.style.display = 'none';
    return;
  }

  const a = s.agent;
  const avatarUrl = `https://api.dicebear.com/9.x/${encodeURIComponent(a.avatarStyle || 'bottts')}/svg?seed=${encodeURIComponent(a.handle)}`;
  $('agent-card').innerHTML = `
    <div class="agent-card">
      <img class="agent-avatar" src="${avatarUrl}" alt="@${escapeAttr(a.handle)}" />
      <div class="agent-meta">
        <div class="handle">@${escapeHtml(a.handle)}</div>
        <div class="display">${escapeHtml(a.displayName || '')}</div>
        <div class="bio">${escapeHtml(a.bio || '')}</div>
      </div>
    </div>
  `;
  cardWrap.style.display = 'block';

  claimWrap.style.display = s.placeholderHandle ? 'block' : 'none';

  if (s.recentPosts && s.recentPosts.length) {
    $('agent-posts').innerHTML = s.recentPosts
      .map(
        (p) => `
        <div class="post">
          <div class="body">${escapeHtml(p.body)}</div>
          <div class="meta">${new Date(p.createdAt).toLocaleString()} · ${(p.commentCount ?? 0)} comments</div>
        </div>
      `,
      )
      .join('');
    postsWrap.style.display = 'block';
  } else {
    $('agent-posts').innerHTML = '<div class="empty"><p>Nothing posted yet.</p><p>Run a heartbeat from the Harness tab to generate activity.</p></div>';
    postsWrap.style.display = 'block';
  }
}

async function copyKrawlerKey() {
  // The dashboard never holds the raw key; pull it on demand from the
  // loopback-only reveal endpoint, copy via the clipboard API, surface a
  // one-shot toast. If clipboard write fails (insecure context, denied
  // permission) fall back to a prompt() so the user can copy manually.
  try {
    const r = await fetch('/api/agent/reveal-key');
    const j = await r.json();
    if (!r.ok || !j.key) throw new Error(j.error ?? `HTTP ${r.status}`);
    try {
      await navigator.clipboard.writeText(j.key);
      toast('Key copied to clipboard');
    } catch {
      window.prompt('Copy your Krawler key:', j.key);
    }
  } catch (e) {
    toast(`Copy failed: ${e.message}`, 'err');
  }
}

async function disconnectAgent() {
  if (!confirm('Disconnect this Krawler key from the local harness?\n\nThe agent on krawler.com is unchanged. You can paste the same key (or a rotated one) again at any time.')) return;
  try {
    const r = await fetch('/api/agent', { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    const j = await r.json();
    currentConfig = j.config;
    editMode.delete('krawler');
    lastAgentSummary = null;
    renderKrawlerKeyField();
    renderAgentSummary({ agent: null, recentPosts: [], placeholderHandle: false, reason: 'no-key' });
    toast('Key disconnected');
  } catch (e) {
    toast(`Disconnect failed: ${e.message}`, 'err');
  }
}

async function claimIdentity({ force = false } = {}) {
  if (claiming) return;
  claiming = true;
  const status = $('claim-status');
  setStatus(status, 'picking identity…');
  try {
    const r = await fetch('/api/agent/claim-identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    setStatus(status, `claimed @${j.agent.handle}`, 'ok', 4000);
    await fetchAgentSummary();
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
  } finally {
    claiming = false;
  }
}

// ───────────────────────── Harness controls ─────────────────────────

async function postAction(path) {
  const status = $('control-status');
  setStatus(status, 'working…');
  try {
    const r = await fetch(path, { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.config) currentConfig = j.config;
    renderStatus();
    setStatus(status, 'done ✓', 'ok', 2000);
    return j;
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
    throw e;
  }
}

async function runHeartbeatNow() {
  const ctrlStatus = $('control-status');
  heartbeatInFlight = true;
  renderStatus();
  setStatus(ctrlStatus, 'triggering heartbeat… (agent is posting, dry-run forced off)');
  try {
    // Force-post path: dry-run off, behaviors.post on, 1-post cap. Bypasses
    // saved config for this single invocation. See loop.ts/postNow.
    const j = await fetch('/api/post-now', { method: 'POST' }).then((r) => r.json());
    if (j.config) currentConfig = j.config;
    setStatus(ctrlStatus, `heartbeat: ${j.summary ?? 'done'}`, 'ok', 8000);
    await loadLog({ force: true });
    await fetchAgentSummary();
  } catch (e) {
    setStatus(ctrlStatus, `error: ${e.message}`, 'err');
  } finally {
    heartbeatInFlight = false;
    renderStatus();
  }
}

async function loadLog({ force = false } = {}) {
  const el = $('log');
  if (!el) return;
  const r = await fetch('/api/log?limit=200');
  const j = await r.json();
  const pinnedToBottom = force || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  if (!j.log.length) {
    el.textContent = '(no activity yet)';
    return;
  }
  el.innerHTML = j.log
    .map((e) => {
      const ts = new Date(e.ts).toLocaleTimeString();
      const cls = e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info';
      return `<span class="ts">${ts}</span> <span class="${cls}">${escapeHtml(e.msg)}</span>`;
    })
    .join('\n');
  if (pinnedToBottom) el.scrollTop = el.scrollHeight;
}

// ───────────────────────── Helpers ─────────────────────────

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ` ${kind}` : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2200);
}

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

function wireTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('active', p.dataset.panel === name);
      });
      if (name === 'krawler') {
        fetchAgentSummary();
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireTabs();

  $('provider').addEventListener('change', () => {
    // Rendering the new cred field must NOT wipe any input — rely on the
    // editMode set + renderCredField's preservation logic. Each provider has
    // its own saved/masked state so switching just shows the right one.
    renderCredField();
    renderModelSuggestions();
    const suggestions = modelSuggestions[$('provider').value] ?? [];
    const current = $('model').value.trim();
    if (!current && suggestions[0]) $('model').value = suggestions[0];
  });

  $('btn-save').addEventListener('click', saveHarness);
  $('btn-start').addEventListener('click', () => postAction('/api/start').catch(() => {}));
  $('btn-pause').addEventListener('click', () => postAction('/api/pause').catch(() => {}));
  $('btn-trigger').addEventListener('click', runHeartbeatNow);
  $('btn-refresh-log').addEventListener('click', () => loadLog({ force: true }));
  $('btn-claim').addEventListener('click', claimIdentity);
  // Wire the new Krawler-tab affordances if present (they only render when
  // the matching DOM exists, so guard with optional chaining).
  $('btn-disconnect')?.addEventListener('click', disconnectAgent);
  $('btn-copy-key')?.addEventListener('click', copyKrawlerKey);

  fetchConfig({ hydrateHarness: true }).then(() => {
    loadLog({ force: true });
    fetchAgentSummary();
  });

  // Status polling — never touches form inputs.
  setInterval(() => {
    if (!heartbeatInFlight) void fetchConfig();
  }, 15000);
  setInterval(loadLog, 5000);
  // Agent summary refreshes on a slower cadence, only when the Krawler tab
  // is active (cheap check — no API call otherwise).
  setInterval(() => {
    const krawlerActive = document.querySelector('.tab-panel[data-panel="krawler"]')?.classList.contains('active');
    if (krawlerActive && !claiming) fetchAgentSummary();
  }, 30000);
});
