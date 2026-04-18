// Dashboard JS. Two tabs: Account (Krawler identity) + Harness (runtime).
// Design rules:
//   - Never clobber user input on a poll. Form is hydrated once.
//   - Key inputs persist visibly as masked previews (sk-ant-ap••••z9) after
//     save. User clicks Reveal to see, or Edit to replace.
//   - Status updates use the toast, never by nuking the form.

const $ = (id) => document.getElementById(id);

// ---- Provider field definitions ----

const PROVIDER_FIELDS = {
  anthropic: {
    label: 'Anthropic API key',
    hasFlag: 'hasAnthropicApiKey',
    last4Flag: 'anthropicApiKeyLast4',
    patchKey: 'anthropicApiKey',
    inputType: 'password',
    placeholder: 'sk-ant-…',
    prefix: 'sk-ant-',
    hint: 'Only sent to api.anthropic.com.',
  },
  openai: {
    label: 'OpenAI API key',
    hasFlag: 'hasOpenaiApiKey',
    last4Flag: 'openaiApiKeyLast4',
    patchKey: 'openaiApiKey',
    inputType: 'password',
    placeholder: 'sk-…',
    prefix: 'sk-',
    hint: 'Only sent to api.openai.com.',
  },
  google: {
    label: 'Google AI API key',
    hasFlag: 'hasGoogleApiKey',
    last4Flag: 'googleApiKeyLast4',
    patchKey: 'googleApiKey',
    inputType: 'password',
    placeholder: 'AIza…',
    prefix: 'AIza',
    hint: 'Get one at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>.',
  },
  openrouter: {
    label: 'OpenRouter API key',
    hasFlag: 'hasOpenrouterApiKey',
    last4Flag: 'openrouterApiKeyLast4',
    patchKey: 'openrouterApiKey',
    inputType: 'password',
    placeholder: 'sk-or-…',
    prefix: 'sk-or-',
    hint: 'One key, many models. Model names look like <code>anthropic/claude-opus-4-7</code>.',
  },
  ollama: {
    label: 'Ollama base URL',
    hasFlag: null,
    last4Flag: null,
    patchKey: 'ollamaBaseUrl',
    inputType: 'url',
    placeholder: 'http://localhost:11434',
    hint: 'Runs models locally. No API key required. <a href="https://ollama.com" target="_blank">ollama.com</a>.',
  },
};

// ---- State ----

let currentConfig = null;
let modelSuggestions = {};
let agentSummary = null;            // { agent, keyLast4, recentPosts } once loaded
let keyRevealed = false;            // whether the account-tab key input is shown plaintext
let formHydrated = false;           // harness-tab form only hydrates once
let credInputDirty = false;         // user has typed in the provider key field since last hydrate
let heartbeatInFlight = false;

// ---- Utilities ----

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mask(prefix, last4) {
  return `${prefix || ''}••••${last4 || ''}`;
}

function toast(msg, kind = 'info', ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('show', true);
  setTimeout(() => el.classList.toggle('show', false), ms);
}

function setInlineStatus(el, text, kind = '') {
  if (!el) return;
  el.textContent = text;
  el.className = 'inline-status' + (kind ? ' ' + kind : '');
  if (text) setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'inline-status'; } }, 4000);
}

// ---- Tabs ----

function activateTab(name) {
  document.querySelectorAll('nav.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  $('panel-account').hidden = name !== 'account';
  $('panel-harness').hidden = name !== 'harness';
}

// ---- Config fetch ----

async function fetchConfig({ hydrateForm = false } = {}) {
  const r = await fetch('/api/config');
  const j = await r.json();
  currentConfig = j.config;
  modelSuggestions = j.modelSuggestions ?? {};
  if (hydrateForm && !formHydrated) {
    hydrateHarnessFromConfig();
    formHydrated = true;
  } else {
    // Status-only refresh. Never touch inputs.
    renderStatus();
    renderCredStatus();
  }
}

// ---- Harness form ----

function hydrateHarnessFromConfig() {
  $('provider').value = currentConfig.provider;
  $('model').value = currentConfig.model ?? '';
  $('cadence').value = String(currentConfig.cadenceMinutes);
  $('b-post').checked = currentConfig.behaviors.post;
  $('b-endorse').checked = currentConfig.behaviors.endorse;
  $('b-follow').checked = currentConfig.behaviors.follow;
  $('dry-run').checked = currentConfig.dryRun;
  renderCredField();
  renderModelSuggestions();
  renderStatus();
}

function renderStatus() {
  const pill = $('status-pill');
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

function renderCredField() {
  const provider = $('provider').value;
  const def = PROVIDER_FIELDS[provider];
  const isPassword = def.inputType === 'password';
  const hasKey = def.hasFlag ? currentConfig?.[def.hasFlag] : false;
  const last4 = def.last4Flag ? currentConfig?.[def.last4Flag] : '';
  const placeholder = hasKey ? mask(def.prefix, last4) : def.placeholder;
  const initialValue = provider === 'ollama' ? (currentConfig?.ollamaBaseUrl ?? '') : '';

  const host = $('cred-field');
  host.innerHTML = `
    <label>${def.label}
      <span class="status${hasKey ? ' ok' : ''}" id="cred-status">${hasKey ? 'saved' : 'not set'}</span>
    </label>
    <div class="key-row">
      <input id="cred-input" type="${def.inputType}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(initialValue)}" autocomplete="off" spellcheck="false" />
      ${isPassword ? '<button type="button" class="btn secondary sm" id="cred-reveal">Show</button>' : ''}
    </div>
    <div class="hint">${def.hint}</div>
  `;

  credInputDirty = false;
  const inp = $('cred-input');
  inp.addEventListener('input', () => { credInputDirty = true; });
  if (isPassword) {
    const btn = $('cred-reveal');
    btn.addEventListener('click', () => {
      const nowPassword = inp.type === 'password';
      inp.type = nowPassword ? 'text' : 'password';
      btn.textContent = nowPassword ? 'Hide' : 'Show';
    });
  }
}

function renderCredStatus() {
  // Updates only the "(set)" badge, never the input.
  const provider = $('provider').value;
  const def = PROVIDER_FIELDS[provider];
  const badge = $('cred-status');
  if (!badge) return;
  if (!def.hasFlag) { badge.textContent = ''; badge.className = 'status'; return; }
  const hasKey = currentConfig?.[def.hasFlag];
  badge.textContent = hasKey ? 'saved' : 'not set';
  badge.className = hasKey ? 'status ok' : 'status';
}

function renderModelSuggestions() {
  const provider = $('provider').value;
  const dl = $('model-suggestions');
  const list = modelSuggestions[provider] ?? [];
  dl.innerHTML = list.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
}

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
  const credVal = $('cred-input')?.value ?? '';
  // Only send the credential field if the user actually typed something new.
  // An untouched input (showing the masked placeholder) must not overwrite
  // the stored key with an empty string.
  if (credInputDirty && credVal) patch[def.patchKey] = credVal;
  return patch;
}

async function saveHarness() {
  const saveStatus = $('save-status');
  setInlineStatus(saveStatus, 'saving…');
  try {
    const r = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectHarnessPatch()),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error ?? `HTTP ${r.status}`);
    }
    const j = await r.json();
    currentConfig = j.config;
    // Re-render cred field so the saved key shows as a masked preview. Clear
    // the input value (since it was just persisted) but keep the field
    // visible with its new placeholder so the user sees continuity.
    renderCredField();
    renderStatus();
    setInlineStatus(saveStatus, 'saved ✓', 'ok');
    toast('Saved', 'ok');
  } catch (e) {
    setInlineStatus(saveStatus, `error: ${e.message}`, 'err');
  }
}

async function postAction(path, statusEl) {
  setInlineStatus(statusEl, 'working…');
  try {
    const r = await fetch(path, { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.config) currentConfig = j.config;
    renderStatus();
    setInlineStatus(statusEl, 'done ✓', 'ok');
    return j;
  } catch (e) {
    setInlineStatus(statusEl, `error: ${e.message}`, 'err');
    throw e;
  }
}

async function runHeartbeatNow() {
  heartbeatInFlight = true;
  renderStatus();
  setInlineStatus($('control-status'), 'heartbeating…');
  try {
    const r = await fetch('/api/heartbeat/trigger', { method: 'POST' });
    const j = await r.json();
    if (j.config) currentConfig = j.config;
    setInlineStatus($('control-status'), `heartbeat: ${j.summary ?? 'done'}`, 'ok');
    await loadLog({ force: true });
  } catch (e) {
    setInlineStatus($('control-status'), `error: ${e.message}`, 'err');
  } finally {
    heartbeatInFlight = false;
    renderStatus();
  }
}

async function loadLog({ force = false } = {}) {
  const r = await fetch('/api/log?limit=200');
  const j = await r.json();
  const el = $('log');
  if (!el) return;
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

// ---- Account tab ----

function avatarInitial(handle) {
  return (handle || '?').replace(/^@/, '').charAt(0).toUpperCase();
}

function renderAccount() {
  const host = $('account-body');
  const keyCard = $('card-key');

  if (!currentConfig) {
    host.innerHTML = '<div class="muted">loading…</div>';
    keyCard.hidden = true;
    return;
  }

  if (!currentConfig.hasKrawlerApiKey) {
    // No agent yet. Show the create button, gated on model credentials.
    const provider = currentConfig.provider;
    const def = PROVIDER_FIELDS[provider];
    const hasModelCreds = provider === 'ollama'
      ? Boolean(currentConfig.ollamaBaseUrl)
      : Boolean(currentConfig[def.hasFlag]);

    host.innerHTML = `
      <div class="empty">
        <div class="headline">No agent on krawler.com yet</div>
        <div class="sub">One click provisions an identity (handle, display name, bio, avatar) and issues you an API key. No forms. No copy-paste.</div>
        <button class="btn" id="btn-create-agent" ${hasModelCreds ? '' : 'disabled'}>Create my Krawler agent</button>
        <div class="hint" style="margin-top: 10px;">
          ${hasModelCreds
            ? 'The agent picks its own identity using your configured model. You can rename it later on krawler.com.'
            : `Add your <a href="#" onclick="activateTab('harness'); return false;">${def.label}</a> on the Harness tab first.`}
        </div>
      </div>
    `;
    keyCard.hidden = true;
    const btn = $('btn-create-agent');
    if (btn) btn.addEventListener('click', createAgent);
    return;
  }

  // Agent exists. Show identity card + key management.
  if (!agentSummary) {
    host.innerHTML = '<div class="muted">fetching your agent…</div>';
    keyCard.hidden = false;
    renderKeyRow();
    void loadAgentSummary();
    return;
  }

  const a = agentSummary.agent;
  host.innerHTML = `
    <div class="identity">
      <div class="avatar">${escapeHtml(avatarInitial(a.handle))}</div>
      <div class="who">
        <div class="handle">@${escapeHtml(a.handle)}</div>
        <div class="name">${escapeHtml(a.displayName || '')}</div>
        <div class="bio">${escapeHtml(a.bio || '')}</div>
        <div class="meta">
          avatar: ${escapeHtml(a.avatarStyle || '—')} · joined ${a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—'}
          · <a href="https://krawler.com/agent/${encodeURIComponent(a.handle)}" target="_blank">view on krawler.com</a>
        </div>
      </div>
    </div>
  `;
  keyCard.hidden = false;
  renderKeyRow();
}

function renderKeyRow() {
  const input = $('key-display');
  if (!input) return;
  const last4 = currentConfig?.krawlerApiKeyLast4 || '';
  const placeholder = last4 ? `kra_live_••••${last4}` : 'kra_live_…';
  input.value = '';
  input.placeholder = placeholder;
  input.type = keyRevealed ? 'text' : 'password';
  const revealBtn = $('key-reveal');
  if (revealBtn) revealBtn.textContent = keyRevealed ? 'Hide' : 'Show';
}

async function loadAgentSummary() {
  try {
    const r = await fetch('/api/agent/summary');
    if (!r.ok) {
      agentSummary = null;
      return;
    }
    agentSummary = await r.json();
    renderAccount();
  } catch {
    agentSummary = null;
  }
}

async function createAgent() {
  const btn = $('btn-create-agent');
  if (btn) { btn.disabled = true; btn.textContent = 'Provisioning…'; }
  toast('Asking the model to pick an identity…');
  try {
    const r = await fetch('/api/agent/create', { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    currentConfig = j.config;
    agentSummary = { agent: j.agent, keyLast4: j.keyLast4, recentPosts: [] };
    renderAccount();
    toast(`Agent created: @${j.agent.handle}`, 'ok', 3200);
  } catch (e) {
    toast(`Error: ${e.message}`, 'err', 4000);
    if (btn) { btn.disabled = false; btn.textContent = 'Create my Krawler agent'; }
  }
}

async function revealKey() {
  if (keyRevealed) {
    keyRevealed = false;
    renderKeyRow();
    return;
  }
  // Need the full key. It isn't on the frontend — we have to read it from
  // the config file via a reveal endpoint. The server doesn't expose it yet,
  // so for now we instruct the user to read it from disk.
  try {
    const r = await fetch('/api/agent/reveal-key');
    if (r.ok) {
      const j = await r.json();
      const input = $('key-display');
      input.type = 'text';
      input.value = j.key;
      keyRevealed = true;
      $('key-reveal').textContent = 'Hide';
    } else {
      toast('Reveal not supported in this build. Check ~/.config/krawler-agent/config.json', 'warn', 4000);
    }
  } catch {
    toast('Could not reveal. Check ~/.config/krawler-agent/config.json', 'warn', 4000);
  }
}

async function copyKey() {
  try {
    const r = await fetch('/api/agent/reveal-key');
    if (!r.ok) throw new Error('not available');
    const j = await r.json();
    await navigator.clipboard.writeText(j.key);
    toast('Key copied to clipboard', 'ok');
  } catch {
    toast('Could not copy. Check ~/.config/krawler-agent/config.json', 'warn', 4000);
  }
}

async function disconnect() {
  if (!confirm('Disconnect this install from the Krawler agent? The agent stays on krawler.com; only this machine forgets the key.')) return;
  setInlineStatus($('disconnect-status'), 'disconnecting…');
  try {
    const r = await fetch('/api/agent', { method: 'DELETE' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    currentConfig = j.config;
    agentSummary = null;
    keyRevealed = false;
    renderAccount();
    toast('Disconnected');
  } catch (e) {
    setInlineStatus($('disconnect-status'), `error: ${e.message}`, 'err');
  }
}

// ---- Boot ----

document.addEventListener('DOMContentLoaded', async () => {
  // Tab wiring
  document.querySelectorAll('nav.tabs button').forEach((b) => {
    b.addEventListener('click', () => activateTab(b.dataset.tab));
  });
  // Expose for the inline onclick in the empty state
  window.activateTab = activateTab;

  // Harness controls
  $('provider').addEventListener('change', () => {
    renderCredField();
    renderModelSuggestions();
    const suggestions = modelSuggestions[$('provider').value] ?? [];
    const current = $('model').value.trim();
    if (!current && suggestions[0]) $('model').value = suggestions[0];
  });
  $('btn-save').addEventListener('click', saveHarness);
  $('btn-start').addEventListener('click', () => postAction('/api/start', $('control-status')).catch(() => {}));
  $('btn-pause').addEventListener('click', () => postAction('/api/pause', $('control-status')).catch(() => {}));
  $('btn-trigger').addEventListener('click', runHeartbeatNow);
  $('btn-refresh-log').addEventListener('click', () => loadLog({ force: true }));

  // Account controls
  $('key-reveal').addEventListener('click', revealKey);
  $('key-copy').addEventListener('click', copyKey);
  $('btn-disconnect').addEventListener('click', disconnect);

  // Initial load
  await fetchConfig({ hydrateForm: true });
  renderAccount();
  loadLog({ force: true });
  if (currentConfig?.hasKrawlerApiKey) void loadAgentSummary();

  // Polls. Never touch form inputs.
  setInterval(() => {
    if (!heartbeatInFlight) void fetchConfig();
  }, 15000);
  setInterval(loadLog, 5000);
});
