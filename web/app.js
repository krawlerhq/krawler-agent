// Dashboard JS. Talks to the Fastify backend at /api/*.

const $ = (id) => document.getElementById(id);

// Per-provider field definition. Each entry describes the credential input
// shown below the model dropdown when that provider is active.
const PROVIDER_FIELDS = {
  anthropic: {
    label: 'Anthropic API key',
    stateKey: 'hasAnthropicApiKey',
    patchKey: 'anthropicApiKey',
    inputType: 'password',
    placeholder: 'sk-ant-…',
    hint: 'Stored in <code>~/.config/krawler-agent/config.json</code> (0600). Only sent to api.anthropic.com.',
  },
  openai: {
    label: 'OpenAI API key',
    stateKey: 'hasOpenaiApiKey',
    patchKey: 'openaiApiKey',
    inputType: 'password',
    placeholder: 'sk-…',
    hint: 'Stored in <code>~/.config/krawler-agent/config.json</code> (0600). Only sent to api.openai.com.',
  },
  google: {
    label: 'Google AI API key',
    stateKey: 'hasGoogleApiKey',
    patchKey: 'googleApiKey',
    inputType: 'password',
    placeholder: 'AIza…',
    hint: 'Get one at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>.',
  },
  openrouter: {
    label: 'OpenRouter API key',
    stateKey: 'hasOpenrouterApiKey',
    patchKey: 'openrouterApiKey',
    inputType: 'password',
    placeholder: 'sk-or-…',
    hint: 'One key, many models. Model names look like <code>anthropic/claude-opus-4-7</code>.',
  },
  ollama: {
    label: 'Ollama base URL',
    stateKey: null,
    patchKey: 'ollamaBaseUrl',
    inputType: 'url',
    placeholder: 'http://localhost:11434',
    hint: 'Runs models locally. No API key required. <a href="https://ollama.com" target="_blank">ollama.com</a>.',
  },
};

let currentConfig = null;
let modelSuggestions = {};
// Set to true once the form has been populated from initial config. After
// that, polling only updates STATUS fields (running, last heartbeat, "set"
// badges) and never the form inputs — so user input isn't clobbered.
let formHydrated = false;
// When a heartbeat is in flight, pause config polls so they don't clobber
// anything mid-operation.
let heartbeatInFlight = false;

async function fetchConfig({ hydrateForm } = { hydrateForm: false }) {
  const r = await fetch('/api/config');
  const j = await r.json();
  currentConfig = j.config;
  modelSuggestions = j.modelSuggestions ?? {};
  if (hydrateForm && !formHydrated) {
    hydrateFormFromConfig();
    formHydrated = true;
  }
  renderStatus();
  renderKeyBadges();
}

function hydrateFormFromConfig() {
  // One-shot population of form inputs from config. Never called again —
  // subsequent polls only touch non-form UI. User's live edits survive.
  $('provider').value = currentConfig.provider;
  $('model').value = currentConfig.model ?? '';
  $('cadence').value = String(currentConfig.cadenceMinutes);
  $('b-post').checked = currentConfig.behaviors.post;
  $('b-endorse').checked = currentConfig.behaviors.endorse;
  $('b-follow').checked = currentConfig.behaviors.follow;
  $('dry-run').checked = currentConfig.dryRun;
  renderCredField({ preserveInput: false });
  renderModelSuggestions();
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

function renderKeyBadges() {
  // Update the "(set)" / "(not set)" badges without touching input values.
  if (!currentConfig) return;
  $('krawler-status').textContent = currentConfig.hasKrawlerApiKey ? '(set)' : '(not set)';
  const credStatus = $('cred-status');
  if (credStatus) {
    const provider = $('provider').value;
    const def = PROVIDER_FIELDS[provider];
    if (def && def.stateKey) {
      credStatus.textContent = currentConfig[def.stateKey] ? '(set)' : '(not set)';
    } else {
      credStatus.textContent = '';
    }
  }
}

function renderCredField({ preserveInput = true } = {}) {
  const provider = $('provider').value;
  const def = PROVIDER_FIELDS[provider];
  const hasKey = def.stateKey && currentConfig ? currentConfig[def.stateKey] : false;
  const existing = preserveInput ? ($('cred-input')?.value ?? '') : '';
  const initialValue =
    existing ||
    (provider === 'ollama' && currentConfig ? currentConfig.ollamaBaseUrl : '');
  $('cred-field').innerHTML = `
    <label>${def.label} <small id="cred-status">${def.stateKey ? (hasKey ? '(set)' : '(not set)') : ''}</small></label>
    <input id="cred-input" type="${def.inputType}" placeholder="${def.placeholder}" value="${escapeHtml(initialValue)}" autocomplete="off" spellcheck="false" />
    <div class="hint">${def.hint}</div>
  `;
}

function renderModelSuggestions() {
  const provider = $('provider').value;
  const dl = $('model-suggestions');
  const list = modelSuggestions[provider] ?? [];
  dl.innerHTML = list.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
}

function collectPatch() {
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
  if (credVal) patch[def.patchKey] = credVal;

  const kra = $('krawler-key').value;
  if (kra) patch.krawlerApiKey = kra;

  return patch;
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

async function save() {
  const saveStatus = $('save-status');
  setStatus(saveStatus, 'saving…');
  try {
    const r = await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectPatch()),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error ?? `HTTP ${r.status}`);
    }
    const j = await r.json();
    currentConfig = j.config;
    // Clear submitted key fields so their cleartext value doesn't linger
    // in the DOM, and refresh the "(set)" badges.
    $('krawler-key').value = '';
    const cred = $('cred-input');
    if (cred && cred.type === 'password') cred.value = '';
    renderStatus();
    renderKeyBadges();
    setStatus(saveStatus, 'saved ✓', 'ok', 2000);
  } catch (e) {
    setStatus(saveStatus, `error: ${e.message}`, 'err');
  }
}

async function postAction(path, controlStatusEl) {
  setStatus(controlStatusEl, 'working…');
  try {
    const r = await fetch(path, { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.config) currentConfig = j.config;
    renderStatus();
    renderKeyBadges();
    setStatus(controlStatusEl, 'done ✓', 'ok', 2000);
    return j;
  } catch (e) {
    setStatus(controlStatusEl, `error: ${e.message}`, 'err');
    throw e;
  }
}

async function runHeartbeatNow() {
  const ctrlStatus = $('control-status');
  heartbeatInFlight = true;
  renderStatus();
  setStatus(ctrlStatus, 'heartbeating… (model call in progress)');
  try {
    const j = await fetch('/api/heartbeat/trigger', { method: 'POST' }).then((r) => r.json());
    if (j.config) currentConfig = j.config;
    setStatus(ctrlStatus, `heartbeat: ${j.summary ?? 'done'}`, 'ok', 6000);
    await loadLog({ force: true });
  } catch (e) {
    setStatus(ctrlStatus, `error: ${e.message}`, 'err');
  } finally {
    heartbeatInFlight = false;
    renderStatus();
    renderKeyBadges();
  }
}

async function loadLog({ force = false } = {}) {
  const r = await fetch('/api/log?limit=200');
  const j = await r.json();
  const el = $('log');
  // Preserve scroll position unless the user is already pinned near the
  // bottom (or we're forcing a jump after a manual action).
  const pinnedToBottom =
    force || el.scrollHeight - el.scrollTop - el.clientHeight < 40;

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

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.addEventListener('DOMContentLoaded', () => {
  $('provider').addEventListener('change', () => {
    renderCredField({ preserveInput: false });
    renderModelSuggestions();
    const suggestions = modelSuggestions[$('provider').value] ?? [];
    // Only prefill model if the user hasn't typed a custom one.
    const current = $('model').value.trim();
    if (!current && suggestions[0]) $('model').value = suggestions[0];
  });

  $('btn-save').addEventListener('click', save);
  $('btn-start').addEventListener('click', () => postAction('/api/start', $('control-status')).catch(() => {}));
  $('btn-pause').addEventListener('click', () => postAction('/api/pause', $('control-status')).catch(() => {}));
  $('btn-trigger').addEventListener('click', runHeartbeatNow);
  $('btn-refresh-log').addEventListener('click', () => loadLog({ force: true }));

  // Initial fetch: hydrate the form. Subsequent polls only update status.
  fetchConfig({ hydrateForm: true }).then(() => loadLog({ force: true }));

  // Poll status + log on an interval. Never touches form inputs.
  setInterval(() => {
    if (!heartbeatInFlight) void fetchConfig();
  }, 15000);
  setInterval(loadLog, 5000);
});
