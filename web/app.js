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

async function fetchConfig() {
  const r = await fetch('/api/config');
  const j = await r.json();
  currentConfig = j.config;
  modelSuggestions = j.modelSuggestions ?? {};
  render();
}

function renderStatus() {
  const pill = $('status-pill');
  if (!currentConfig) {
    pill.textContent = 'loading…';
    pill.className = 'pill muted';
    return;
  }
  if (currentConfig.running) {
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
  const hasKey = def.stateKey && currentConfig ? currentConfig[def.stateKey] : false;
  const currentValue =
    provider === 'ollama' && currentConfig ? currentConfig.ollamaBaseUrl : '';
  $('cred-field').innerHTML = `
    <label>${def.label} <small id="cred-status">${def.stateKey ? (hasKey ? '(set)' : '(not set)') : ''}</small></label>
    <input id="cred-input" type="${def.inputType}" placeholder="${def.placeholder}" value="${escapeHtml(currentValue)}" autocomplete="off" spellcheck="false" />
    <div class="hint">${def.hint}</div>
  `;
}

function renderModelSuggestions() {
  const provider = $('provider').value;
  const dl = $('model-suggestions');
  const list = modelSuggestions[provider] ?? [];
  dl.innerHTML = list.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
}

function render() {
  if (!currentConfig) return;

  $('provider').value = currentConfig.provider;
  $('model').value = currentConfig.model ?? '';
  $('cadence').value = String(currentConfig.cadenceMinutes);
  $('b-post').checked = currentConfig.behaviors.post;
  $('b-endorse').checked = currentConfig.behaviors.endorse;
  $('b-follow').checked = currentConfig.behaviors.follow;
  $('dry-run').checked = currentConfig.dryRun;

  $('krawler-status').textContent = currentConfig.hasKrawlerApiKey ? '(set)' : '(not set)';
  $('krawler-key').value = '';

  renderCredField();
  renderModelSuggestions();
  renderStatus();
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

  // Provider-specific credential. Empty string means "leave unchanged" server-side.
  const def = PROVIDER_FIELDS[provider];
  const credVal = $('cred-input')?.value ?? '';
  if (credVal) patch[def.patchKey] = credVal;

  // Krawler key, same rule: empty = leave unchanged.
  const kra = $('krawler-key').value;
  if (kra) patch.krawlerApiKey = kra;

  return patch;
}

async function save() {
  $('save-status').textContent = 'saving…';
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
    render();
    $('save-status').textContent = 'saved ✓';
    setTimeout(() => ($('save-status').textContent = ''), 2000);
  } catch (e) {
    $('save-status').textContent = `error: ${e.message}`;
  }
}

async function postAction(path) {
  const r = await fetch(path, { method: 'POST' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.config) currentConfig = j.config;
  render();
  return j;
}

async function loadLog() {
  const r = await fetch('/api/log?limit=200');
  const j = await r.json();
  const el = $('log');
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
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Wire events
document.addEventListener('DOMContentLoaded', () => {
  $('provider').addEventListener('change', () => {
    renderCredField();
    renderModelSuggestions();
    const suggestions = modelSuggestions[$('provider').value] ?? [];
    if (suggestions[0]) $('model').value = suggestions[0];
  });

  $('btn-save').addEventListener('click', save);
  $('btn-start').addEventListener('click', () => postAction('/api/start'));
  $('btn-pause').addEventListener('click', () => postAction('/api/pause'));
  $('btn-trigger').addEventListener('click', async () => {
    $('save-status').textContent = 'heartbeating…';
    try {
      const j = await fetch('/api/heartbeat/trigger', { method: 'POST' }).then((r) => r.json());
      $('save-status').textContent = `heartbeat: ${j.summary ?? 'done'}`;
      if (j.config) currentConfig = j.config;
      render();
      loadLog();
    } catch (e) {
      $('save-status').textContent = `error: ${e.message}`;
    }
  });
  $('btn-refresh-log').addEventListener('click', loadLog);

  fetchConfig().then(loadLog);
  setInterval(loadLog, 5000);
  setInterval(fetchConfig, 15000);
});
