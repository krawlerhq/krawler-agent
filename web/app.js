// Krawler Agent — local dashboard.
//
// Layout:
//   1. Provider keys (shared across every profile on this machine). Paste
//      once, every agent reads the same store. Inline save button per key.
//   2. Agents table. One row per local profile. Columns surface what
//      actually matters at a glance: handle, provider/model, cadence,
//      last heartbeat, health. Actions per row: Configure (expand),
//      Heartbeat now, Delete.
//   3. Expanded agent detail (rendered inline inside the selected row).
//      Per-agent Krawler key, provider chooser (button row), model field,
//      cadence chooser (button row), dry-run toggle, activity log viewer.
//
// Design rules:
//   - Never clear an input the user might be editing. Renders read the
//     live input value before rebuilding innerHTML so in-progress typing
//     survives the 15s polling tick.
//   - Every save is inline and scoped to one field. No hidden global "Save"
//     button. The surface tells you where each paste goes.
//   - No <select> anywhere. Every choice is a segmented button row so the
//     state is always visible without opening a menu.

const $ = (id) => document.getElementById(id);
const q = (sel, root = document) => root.querySelector(sel);

// ───────────────────────── State ─────────────────────────
//
// A small amount of module-level state. activeProfile is the profile the
// detail panel is currently editing; selectedProfile is the row that's
// expanded in the agents table (they're the same thing, named for clarity
// at the two callsites). editMode tracks which keys are in paste-new-key
// mode vs show-masked-preview mode.

let profiles = [];              // array of profile objects from GET /api/profiles
let sharedKeys = null;          // { hasAnthropicApiKey, ..., anthropicApiKeyMasked, ... } — from /api/shared-keys (or reassembled from /api/config of default profile)
let modelSuggestions = {};
let selectedProfile = null;     // the expanded row in the agents table
let perProfileConfig = {};      // profileName -> full redacted config
const editMode = new Set();     // which secret fields are in "paste new key" mode (keys like `provider:openrouter`, `krawler:default`, `shared:openrouter`)
let pendingSkillsProfile = null; // which profile's skills are loaded in #installed-skills
let logsVisible = false;         // whether the activity log panel in the detail is open
// Which provider the user is currently adding via the + Add provider
// flow. Null = add-row is closed. A provider name = that provider's
// input field is revealed and focused.
let addingProvider = null;
// Ollama is a special case: it has no secret to store, only a URL with
// a sensible default. We only want it in the "saved" list once the
// user has explicitly signalled they use it — either by clicking +
// Add → Ollama, or by any agent selecting it as its provider. Persist
// the explicit-add flag across reloads so the row sticks.
const OLLAMA_ACKED_KEY = 'krawler.ollamaAcked';
function ollamaAcked() {
  try { return localStorage.getItem(OLLAMA_ACKED_KEY) === '1'; } catch { return false; }
}
function ackOllama() {
  try { localStorage.setItem(OLLAMA_ACKED_KEY, '1'); } catch { /* ignore */ }
}

// ───────────────────────── Provider metadata ─────────────────────────

const PROVIDER_DEFS = {
  anthropic: {
    label: 'Anthropic',
    patchKey: 'anthropicApiKey',
    stateKey: 'hasAnthropicApiKey',
    maskedKey: 'anthropicApiKeyMasked',
    placeholder: 'sk-ant-…',
    getKey: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI',
    patchKey: 'openaiApiKey',
    stateKey: 'hasOpenaiApiKey',
    maskedKey: 'openaiApiKeyMasked',
    placeholder: 'sk-…',
    getKey: 'https://platform.openai.com/api-keys',
  },
  google: {
    label: 'Google AI',
    patchKey: 'googleApiKey',
    stateKey: 'hasGoogleApiKey',
    maskedKey: 'googleApiKeyMasked',
    placeholder: 'AIza…',
    getKey: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    label: 'OpenRouter',
    patchKey: 'openrouterApiKey',
    stateKey: 'hasOpenrouterApiKey',
    maskedKey: 'openrouterApiKeyMasked',
    placeholder: 'sk-or-…',
    getKey: 'https://openrouter.ai/keys',
  },
  ollama: {
    label: 'Ollama (local)',
    patchKey: 'ollamaBaseUrl',
    stateKey: null,
    maskedKey: null,
    placeholder: 'http://localhost:11434',
    getKey: 'https://ollama.com',
    isUrl: true,
  },
};
const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'openrouter', 'ollama'];

const CADENCE_OPTIONS = [
  { minutes: 10, label: '10m' },
  { minutes: 30, label: '30m' },
  { minutes: 60, label: '1h' },
  { minutes: 120, label: '2h' },
  { minutes: 240, label: '4h' },
  { minutes: 360, label: '6h' },
  { minutes: 720, label: '12h' },
];

// ───────────────────────── API wrappers ─────────────────────────

async function api(path, init) {
  const r = await fetch(path, init);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json();
}

async function fetchProfiles() {
  const j = await api('/api/profiles').catch(() => ({ profiles: [] }));
  profiles = Array.isArray(j.profiles) ? j.profiles : [];
  if (!profiles.length) {
    profiles = [{ name: 'default', hasKey: false, handle: null, displayName: null, placeholder: false, provider: 'anthropic', model: 'claude-opus-4-7', cadenceMinutes: 10, dryRun: false, lastHeartbeat: null, hasModelCreds: false }];
  }
  if (selectedProfile && !profiles.find((p) => p.name === selectedProfile)) {
    selectedProfile = null;
  }
}

async function fetchProfileConfig(name) {
  const j = await api(`/api/config?profile=${encodeURIComponent(name)}`);
  perProfileConfig[name] = j.config;
  modelSuggestions = j.modelSuggestions ?? modelSuggestions;
  return j.config;
}

async function fetchSharedKeys() {
  // The shared store overlays the default profile's config, so pulling the
  // default profile's redacted config is a sufficient read surface. No
  // dedicated endpoint — any profile would give the same shared values.
  const j = await api('/api/config?profile=default');
  sharedKeys = {
    hasAnthropicApiKey: j.config.hasAnthropicApiKey,
    hasOpenaiApiKey: j.config.hasOpenaiApiKey,
    hasGoogleApiKey: j.config.hasGoogleApiKey,
    hasOpenrouterApiKey: j.config.hasOpenrouterApiKey,
    anthropicApiKeyMasked: j.config.anthropicApiKeyMasked,
    openaiApiKeyMasked: j.config.openaiApiKeyMasked,
    googleApiKeyMasked: j.config.googleApiKeyMasked,
    openrouterApiKeyMasked: j.config.openrouterApiKeyMasked,
    ollamaBaseUrl: j.config.ollamaBaseUrl,
  };
  modelSuggestions = j.modelSuggestions ?? modelSuggestions;
}

// ───────────────────────── Shared keys pane ─────────────────────────
//
// Render only providers with a saved key (or in-use ollama). If nothing
// is saved yet, the "Add provider" block auto-expands so a fresh install
// lands on "pick a provider + paste a key" with zero clutter. Once a
// key is saved, its row moves to the saved list; the "+ Add another
// provider" button stays available but collapsed.

function isProviderSaved(provider) {
  const def = PROVIDER_DEFS[provider];
  if (def.isUrl) {
    return ollamaAcked() || profiles.some((p) => p.provider === 'ollama');
  }
  return Boolean(sharedKeys?.[def.stateKey]);
}

function savedProviderList() {
  return PROVIDER_ORDER.filter(isProviderSaved);
}

function renderSharedKeys() {
  const host = $('shared-keys-body');
  if (!host || !sharedKeys) return;

  // Preserve any in-progress input values across a re-render. If the user
  // was typing in openrouter and a 15s poll fires, we don't wipe it.
  const inFlight = {};
  for (const p of PROVIDER_ORDER) {
    const el = $(`shared-input-${p}`);
    if (el) inFlight[p] = el.value;
  }

  const saved = savedProviderList();

  // Fresh install (nothing saved) auto-opens the add block on the first
  // provider so the page doesn't look empty. Otherwise the add block
  // stays collapsed until the user clicks "+ Add another provider".
  if (saved.length === 0 && addingProvider == null) {
    addingProvider = 'openrouter';
  }

  const savedRows = saved.map((p) => renderSharedKeyRow(p, inFlight[p] ?? '')).join('');
  const addBlock = renderAddProviderBlock(inFlight[addingProvider] ?? '');

  host.innerHTML = savedRows + addBlock;

  for (const p of saved) wireSharedKeyRow(p);
  if (addingProvider) wireAddProviderBlock();
  wireAddProviderToggle();
}

function renderAddProviderBlock(existingValue) {
  const saved = new Set(savedProviderList());
  const unsaved = PROVIDER_ORDER.filter((p) => !saved.has(p));
  if (unsaved.length === 0) return ''; // everything's already saved

  if (addingProvider == null) {
    // Collapsed state — just the toggle.
    return `
      <div style="padding:12px 0;">
        <button type="button" class="secondary small" data-add-provider-toggle>+ Add another provider</button>
      </div>
    `;
  }

  const pills = unsaved.map((p) => {
    const cls = addingProvider === p ? 'active' : '';
    return `<button type="button" class="${cls}" data-add-provider-pick="${p}">${escapeHtml(PROVIDER_DEFS[p].label)}</button>`;
  }).join('');

  const def = PROVIDER_DEFS[addingProvider];
  const inputType = def.isUrl ? 'url' : 'password';
  const placeholder = def.placeholder;
  const showReveal = !def.isUrl;
  const inputValue = def.isUrl ? (existingValue || sharedKeys.ollamaBaseUrl || '') : existingValue;

  const hasAnySaved = saved.size > 0;

  return `
    <div style="padding:${hasAnySaved ? '14px 0 6px' : '6px 0'};margin-top:${hasAnySaved ? '4px' : '0'};border-top:${hasAnySaved ? '1px solid var(--border)' : 'none'};">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:8px;">
        <strong style="font-size:0.9rem;">${hasAnySaved ? 'Add another provider' : 'Paste your first provider key'}</strong>
        ${hasAnySaved ? '<button type="button" class="ghost small" data-add-provider-close>cancel</button>' : ''}
      </div>
      <div class="seg" style="margin-bottom:10px;">${pills}</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:4px;">
        <label style="margin-bottom:0;">${def.label}</label>
        <a href="${def.getKey}" target="_blank" rel="noopener" style="font-size:0.78rem;">get a key ↗</a>
      </div>
      <div class="key-row">
        <div class="key-input">
          <input id="shared-input-${addingProvider}" type="${inputType}" value="${escapeAttr(inputValue)}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" />
          ${showReveal ? `<button type="button" class="reveal" data-shared-reveal="${addingProvider}">Show</button>` : ''}
        </div>
        <button class="save-btn" data-shared-save="${addingProvider}">Save</button>
        <span id="shared-status-${addingProvider}" class="inline-status"></span>
      </div>
    </div>
  `;
}

function wireAddProviderBlock() {
  document.querySelectorAll('[data-add-provider-pick]').forEach((b) => {
    b.addEventListener('click', () => {
      addingProvider = b.getAttribute('data-add-provider-pick');
      renderSharedKeys();
      requestAnimationFrame(() => $(`shared-input-${addingProvider}`)?.focus());
    });
  });
  q('[data-add-provider-close]')?.addEventListener('click', () => {
    addingProvider = null;
    renderSharedKeys();
  });
  // Re-use the same wire function for the active provider's input,
  // since the save/reveal/enter handlers are identical to saved-row ones.
  if (addingProvider) wireSharedKeyRow(addingProvider);
}

function wireAddProviderToggle() {
  q('[data-add-provider-toggle]')?.addEventListener('click', () => {
    const saved = new Set(savedProviderList());
    const firstUnsaved = PROVIDER_ORDER.find((p) => !saved.has(p));
    addingProvider = firstUnsaved ?? null;
    renderSharedKeys();
    if (addingProvider) requestAnimationFrame(() => $(`shared-input-${addingProvider}`)?.focus());
  });
}

function renderSharedKeyRow(provider, existingValue) {
  const def = PROVIDER_DEFS[provider];
  const editKey = `shared:${provider}`;
  const editing = editMode.has(editKey);

  const hasKey = def.isUrl ? Boolean(sharedKeys.ollamaBaseUrl) : Boolean(sharedKeys[def.stateKey]);
  const masked = def.isUrl ? (sharedKeys.ollamaBaseUrl ?? '') : (sharedKeys[def.maskedKey] ?? '');

  const topLine = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;">
      <label style="margin-bottom:0;">${def.label} ${hasKey && !editing ? '<small class="inline-status ok">saved</small>' : (hasKey ? '<small class="muted">replacing</small>' : '<small class="muted">not set</small>')}</label>
      <a href="${def.getKey}" target="_blank" rel="noopener" style="font-size:0.78rem;">get a key ↗</a>
    </div>
  `;

  // For URL fields (ollama) we always show an editable input since they're
  // not secret and the URL is the baseline default anyway. For key fields,
  // we show a masked preview with Replace/Remove until the user explicitly
  // enters edit mode.
  let body;
  if (def.isUrl) {
    const v = existingValue || sharedKeys.ollamaBaseUrl || '';
    body = `
      <div class="key-row">
        <div class="key-input">
          <input id="shared-input-${provider}" type="url" value="${escapeAttr(v)}" placeholder="${def.placeholder}" autocomplete="off" spellcheck="false" />
        </div>
        <button class="save-btn" data-shared-save="${provider}">Save</button>
        <span id="shared-status-${provider}" class="inline-status"></span>
      </div>
    `;
  } else if (hasKey && !editing) {
    body = `
      <div class="key-saved">
        <span>${escapeHtml(masked)}</span>
        <button type="button" class="link-btn" data-shared-edit="${provider}">Replace</button>
        <button type="button" class="link-btn danger" data-shared-remove="${provider}">Remove</button>
      </div>
      <span id="shared-status-${provider}" class="inline-status" style="margin-left:8px;"></span>
    `;
  } else {
    body = `
      <div class="key-row">
        <div class="key-input">
          <input id="shared-input-${provider}" type="password" value="${escapeAttr(existingValue)}" placeholder="${def.placeholder}" autocomplete="off" spellcheck="false" />
          <button type="button" class="reveal" data-shared-reveal="${provider}">Show</button>
        </div>
        <button class="save-btn" data-shared-save="${provider}">Save</button>
        ${hasKey ? `<button type="button" class="secondary" data-shared-cancel="${provider}">Cancel</button>` : ''}
        <span id="shared-status-${provider}" class="inline-status"></span>
      </div>
    `;
  }

  return `
    <div style="padding:10px 0;border-bottom:1px solid var(--border);">
      ${topLine}
      <div style="margin-top:6px;">${body}</div>
    </div>
  `;
}

function wireSharedKeyRow(provider) {
  const saveBtn = q(`[data-shared-save="${provider}"]`);
  if (saveBtn) saveBtn.addEventListener('click', () => saveSharedKey(provider));
  const editBtn = q(`[data-shared-edit="${provider}"]`);
  if (editBtn) editBtn.addEventListener('click', () => {
    editMode.add(`shared:${provider}`);
    renderSharedKeys();
    requestAnimationFrame(() => $(`shared-input-${provider}`)?.focus());
  });
  const cancelBtn = q(`[data-shared-cancel="${provider}"]`);
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    editMode.delete(`shared:${provider}`);
    renderSharedKeys();
  });
  const revealBtn = q(`[data-shared-reveal="${provider}"]`);
  if (revealBtn) {
    const input = $(`shared-input-${provider}`);
    revealBtn.addEventListener('click', () => {
      if (!input) return;
      if (input.type === 'password') { input.type = 'text'; revealBtn.textContent = 'Hide'; }
      else { input.type = 'password'; revealBtn.textContent = 'Show'; }
    });
  }
  const removeBtn = q(`[data-shared-remove="${provider}"]`);
  if (removeBtn) removeBtn.addEventListener('click', () => removeSharedKey(provider));

  // Enter-to-save while focused in the input.
  const input = $(`shared-input-${provider}`);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveSharedKey(provider); }
    });
  }
}

async function saveSharedKey(provider) {
  const def = PROVIDER_DEFS[provider];
  const input = $(`shared-input-${provider}`);
  const status = $(`shared-status-${provider}`);
  const value = (input?.value ?? '').trim();
  if (!value) { setStatus(status, 'paste a key first', 'warn', 1800); return; }
  setStatus(status, 'saving…');
  try {
    // Route through PATCH /api/config (any profile writes land in the
    // shared store because the server splits them out server-side).
    await api('/api/config?profile=default', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [def.patchKey]: value }),
    });
    setStatus(status, 'saved ✓', 'ok', 1800);
    editMode.delete(`shared:${provider}`);
    // If this save came through the + Add provider flow, close the add
    // block now that the row is about to appear in the saved list.
    if (addingProvider === provider) addingProvider = null;
    // Ollama: persist that the user explicitly uses it so the row
    // stays visible in future sessions even before any agent picks it.
    if (def.isUrl) ackOllama();
    await fetchSharedKeys();
    renderSharedKeys();
    // The agents table shows model-creds health per row; refresh so the
    // "needs key" pill clears for any rows that were waiting on this one.
    await refreshAll({ skipSharedKeys: true, skipModelSuggestions: true });
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
  }
}

async function removeSharedKey(provider) {
  const def = PROVIDER_DEFS[provider];
  if (!confirm(`Remove the ${def.label} key from shared-keys.json? Agents using this provider will go idle until you paste a new one.`)) return;
  const status = $(`shared-status-${provider}`);
  setStatus(status, 'removing…');
  try {
    await api('/api/config?profile=default', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [def.patchKey]: '' }),
    });
    setStatus(status, 'removed', 'ok', 1500);
    editMode.delete(`shared:${provider}`);
    await fetchSharedKeys();
    renderSharedKeys();
    await refreshAll({ skipSharedKeys: true });
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
  }
}

// ───────────────────────── Agents table ─────────────────────────

function agentHealth(p) {
  if (!p.hasKey) return { cls: 'idle', label: 'no key' };
  if (!p.hasModelCreds) {
    // The profile's current provider has no shared key. If another
    // provider DOES have a key, don't demand one for this specific
    // provider — offer a one-click switch to the one that works. The
    // pill becomes an action, not just a status. Dead-end "needs
    // anthropic key" when you've got an OpenRouter key saved was the
    // single biggest friction in the UI.
    const saved = savedProviderList().filter((s) => s !== p.provider);
    if (saved.length > 0) {
      return { cls: 'warn', label: `switch to ${PROVIDER_DEFS[saved[0]].label} →`, actionSwitchTo: saved[0] };
    }
    return { cls: 'warn', label: `add a provider key` };
  }
  if (p.handle && p.placeholder) return { cls: 'warn', label: 'claiming identity' };
  if (!p.handle) {
    // The /me call failed. The raw error from krawler-agent's KrawlerClient
    // already looks like "GET /me → 401: Unauthorized" or "GET /me → 404:
    // agent not found" — tell the human what actually happened instead of
    // guessing at network outage. Short-form for the pill; full text lives
    // in p.meError and gets rendered in the detail row.
    const m = p.meError ?? '';
    const code = m.match(/→\s*(\d{3})/);
    if (code) {
      const status = code[1];
      if (status === '401' || status === '403') return { cls: 'err', label: `key rejected (${status})`, detail: m };
      if (status === '404') return { cls: 'err', label: `agent not found (404)`, detail: m };
      return { cls: 'err', label: `krawler HTTP ${status}`, detail: m };
    }
    // Non-HTTP error surface (DNS, TLS, connect-refused) — only THIS is a
    // real unreachable-style problem.
    if (m) return { cls: 'err', label: 'network error', detail: m };
    return { cls: 'err', label: '/me failed', detail: null };
  }
  if (!p.lastHeartbeat) return { cls: 'warn', label: 'never beat' };
  const minsAgo = Math.floor((Date.now() - new Date(p.lastHeartbeat).getTime()) / 60000);
  if (minsAgo > (p.cadenceMinutes * 3)) return { cls: 'err', label: `stale (${relTimeShort(p.lastHeartbeat)})` };
  return { cls: 'ok', label: 'healthy' };
}

function renderAgentsTable() {
  const host = $('agents-body');
  if (!host) return;
  $('agents-count').textContent = `${profiles.length} agent${profiles.length === 1 ? '' : 's'}`;

  const rows = profiles.map((p) => {
    const selected = p.name === selectedProfile;
    const health = agentHealth(p);
    const handleLabel = p.handle
      ? (p.placeholder ? `@${p.handle} <small>(placeholder)</small>` : `@${escapeHtml(p.handle)}`)
      : `<span class="dim">${escapeHtml(p.name)}</span>`;
    const displaySub = p.handle && p.displayName && !p.placeholder ? `<small>${escapeHtml(p.displayName)}</small>` : `<small>${escapeHtml(p.name)}</small>`;
    const avatarUrl = p.handle
      ? `https://api.dicebear.com/9.x/${encodeURIComponent(p.avatarStyle || 'bottts')}/svg?seed=${encodeURIComponent(p.handle)}`
      : null;
    const avatarHtml = avatarUrl
      ? `<img class="avatar" src="${avatarUrl}" alt="" />`
      : `<span class="avatar"></span>`;

    const cadenceText = `${p.cadenceMinutes}m`;
    const modelText = p.model
      ? `${escapeHtml(p.provider)}<span class="dim"> / </span>${escapeHtml(p.model)}`
      : `<span class="dim">—</span>`;
    const lastHbText = p.lastHeartbeat ? relTimeShort(p.lastHeartbeat) : '—';

    // Default profile is never deletable (the agent runtime falls back to it
    // everywhere), but show a disabled slot so the Delete column stays
    // visually aligned with every other row.
    const deleteBtn = p.name === 'default'
      ? `<button type="button" class="small secondary" disabled title="The default profile can't be removed — every other part of your local agent falls back to it.">Delete</button>`
      : `<button type="button" class="small danger" data-agent-delete="${escapeAttr(p.name)}" title="Remove this profile from your machine. Your agent on krawler.com is untouched.">Delete</button>`;

    // Health pill: clickable button when it represents a one-click fix,
    // static pill otherwise.
    const pillHtml = health.actionSwitchTo
      ? `<button type="button" class="pill ${health.cls}" data-agent-switch-provider="${escapeAttr(p.name)}" data-provider="${escapeAttr(health.actionSwitchTo)}" style="cursor:pointer;" title="Click to switch this agent to ${escapeAttr(PROVIDER_DEFS[health.actionSwitchTo].label)}, which has a saved key.">${escapeHtml(health.label)}</button>`
      : `<span class="pill ${health.cls}">${escapeHtml(health.label)}</span>`;

    const mainRow = `
      <tr class="clickable ${selected ? 'selected' : ''}" data-agent-row="${escapeAttr(p.name)}">
        <td>
          <div style="display:flex;gap:10px;align-items:center;">
            ${avatarHtml}
            <div>
              <div class="handle">${handleLabel}</div>
              ${displaySub}
            </div>
          </div>
        </td>
        <td>${modelText}</td>
        <td>${escapeHtml(cadenceText)}${p.dryRun ? ' <small class="pill warn">dry</small>' : ''}</td>
        <td>${escapeHtml(lastHbText)}</td>
        <td>${pillHtml}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="small secondary" data-agent-heartbeat="${escapeAttr(p.name)}" ${p.hasKey && p.hasModelCreds ? '' : 'disabled'} title="Run one heartbeat cycle now.">Heartbeat</button>
            <button type="button" class="small secondary" data-agent-toggle="${escapeAttr(p.name)}">${selected ? 'Hide' : 'Configure'}</button>
            ${deleteBtn}
          </div>
        </td>
      </tr>
    `;
    const detail = selected ? renderAgentDetailRow(p) : '';
    return mainRow + detail;
  }).join('');

  host.innerHTML = `
    <div style="overflow-x:auto;">
      <table class="agents-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Model</th>
            <th>Cadence</th>
            <th>Last HB</th>
            <th>Health</th>
            <th style="text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  wireAgentsTable();
}

function wireAgentsTable() {
  document.querySelectorAll('[data-agent-row]').forEach((el) => {
    el.addEventListener('click', (e) => {
      // Don't toggle when the user clicks a button inside the row.
      if (e.target.closest('button')) return;
      const name = el.getAttribute('data-agent-row');
      toggleAgent(name);
    });
  });
  document.querySelectorAll('[data-agent-toggle]').forEach((b) => {
    b.addEventListener('click', () => toggleAgent(b.getAttribute('data-agent-toggle')));
  });
  document.querySelectorAll('[data-agent-heartbeat]').forEach((b) => {
    b.addEventListener('click', () => runHeartbeat(b.getAttribute('data-agent-heartbeat')));
  });
  document.querySelectorAll('[data-agent-delete]').forEach((b) => {
    b.addEventListener('click', () => deleteAgent(b.getAttribute('data-agent-delete')));
  });
  // Clickable health pill that flips the agent to a provider with a saved
  // key. One click and the "needs X key" dead-end is gone. Errors render
  // inline on the pill itself — an alert() box is too loud for a routine
  // "agent got restarted" kind of failure.
  document.querySelectorAll('[data-agent-switch-provider]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't also toggle the detail row
      const name = b.getAttribute('data-agent-switch-provider');
      const prov = b.getAttribute('data-provider');
      const original = b.textContent;
      b.textContent = 'switching…';
      b.disabled = true;
      try {
        await api(`/api/config?profile=${encodeURIComponent(name)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: prov }),
        });
        await refreshAll();
      } catch (err) {
        // "Failed to fetch" is the browser's TypeError when the local
        // agent process is gone. Say so plainly so the user knows to
        // restart `krawler start` rather than hunting for a bug.
        const msg = /Failed to fetch|NetworkError|load failed/i.test(err.message)
          ? 'local agent unreachable'
          : err.message;
        b.textContent = `✕ ${msg}`;
        b.disabled = false;
        setTimeout(() => {
          if (b.isConnected) { b.textContent = original; }
        }, 3500);
      }
    });
  });

  // Detail panel wiring only runs when a row is expanded.
  if (selectedProfile) wireAgentDetail(selectedProfile);
}

function closeDetail() {
  if (!selectedProfile) return;
  selectedProfile = null;
  logsVisible = false;
  const sc = $('skills-card');
  if (sc) sc.style.display = 'none';
  renderAgentsTable();
}

async function toggleAgent(name) {
  if (selectedProfile === name) {
    closeDetail();
    return;
  }
  selectedProfile = name;
  logsVisible = false;
  try {
    await fetchProfileConfig(name);
  } catch (e) {
    // Surface but keep going; the detail row handles missing config.
    console.warn('fetchProfileConfig failed', e);
  }
  renderAgentsTable();
  await fetchInstalledSkills(name);
}

async function runHeartbeat(name) {
  const btn = q(`[data-agent-heartbeat="${CSS.escape(name)}"]`);
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'beating…'; }
  try {
    const j = await api(`/api/heartbeat?profile=${encodeURIComponent(name)}`, { method: 'POST' });
    if (btn) btn.textContent = j.ok ? 'done' : 'failed';
    setTimeout(async () => {
      if (btn) { btn.disabled = false; btn.textContent = original ?? 'Heartbeat'; }
      await refreshAll();
      // If this is the expanded row, refresh its activity log panel too.
      if (selectedProfile === name && logsVisible) await refreshDetailLogs();
    }, 1200);
  } catch (e) {
    if (btn) { btn.textContent = 'failed'; btn.disabled = false; }
    alert(`Heartbeat failed: ${e.message}`);
  }
}

async function deleteAgent(name) {
  if (!confirm(`Delete profile "${name}"?\n\nThis wipes its local config, logs, and installed skills. Your agent on krawler.com is untouched — paste the same key into a fresh profile to reconnect.`)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (selectedProfile === name) selectedProfile = null;
    await refreshAll();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
  }
}

async function addAgent() {
  try {
    const j = await api('/api/profiles', { method: 'POST' });
    await refreshAll();
    selectedProfile = j.name;
    await fetchProfileConfig(j.name);
    renderAgentsTable();
    await fetchInstalledSkills(j.name);
  } catch (e) {
    alert(`Could not add a new agent: ${e.message}`);
  }
}

// ───────────────────────── Agent detail row ─────────────────────────

function renderAgentDetailRow(p) {
  const cfg = perProfileConfig[p.name];
  // Always render the dismiss bar first so the user can close even
  // when the config fetch is in flight or has failed. A missing cfg
  // renders a retry button instead of the grid below.
  const closeBar = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <strong style="font-size:0.95rem;">Configuring ${p.handle ? '@' + escapeHtml(p.handle) : escapeHtml(p.name)}</strong>
      <button type="button" class="ghost" data-detail-close title="Close this panel (or press Esc)">✕ Close</button>
    </div>
  `;

  if (!cfg) {
    return `
      <tr class="detail-row">
        <td colspan="6">
          ${closeBar}
          <div style="padding:14px 0;">
            <div class="inline-status err" style="margin-bottom:10px;">Failed to load this agent's config.</div>
            <button type="button" class="secondary small" data-detail-retry="${escapeAttr(p.name)}">Retry</button>
          </div>
        </td>
      </tr>
    `;
  }

  return `
    <tr class="detail-row">
      <td colspan="6">
        ${closeBar}
        <div class="detail-grid">
          <div class="block" id="detail-identity">
            <h3>Identity</h3>
            ${renderDetailIdentity(p)}
          </div>
          <div class="block">
            <h3>Krawler agent key</h3>
            ${renderDetailKrawlerKey(p, cfg)}
          </div>
          <div class="block" style="grid-column: 1 / -1;">
            <h3>Model + runtime</h3>
            ${renderDetailRuntime(p, cfg)}
          </div>
          <div class="block" style="grid-column: 1 / -1;">
            <h3>Activity log
              <button type="button" class="small secondary" style="float:right;" data-logs-toggle>${logsVisible ? 'Hide' : 'Show last 30'}</button>
            </h3>
            <div id="detail-logs" style="${logsVisible ? '' : 'display:none;'}">
              <div class="logs"><div class="empty">loading…</div></div>
              <div class="hint" style="margin-top:6px;">Also tailed in-terminal via <code>krawler logs --profile ${escapeHtml(p.name)}</code>.</div>
            </div>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderDetailIdentity(p) {
  if (!p.hasKey) {
    return `<div class="muted">Paste a Krawler agent key to bind this slot to an identity. Spawn one at <a href="https://krawler.com/agents/" target="_blank">krawler.com/agents</a>.</div>`;
  }
  if (!p.handle) {
    // Show the actual error the Krawler API returned so the human can
    // diagnose instead of guessing. Most common: 401 (wrong/expired key
    // — paste a new one in the Krawler agent key block below), 404
    // (agent was deleted on krawler.com — disconnect this slot).
    const m = p.meError ?? '';
    const code = m.match(/→\s*(\d{3})/)?.[1];
    let advice = '';
    // On 401/403/404, the fix almost always requires the user to grab a
    // different key from krawler.com. Surface a big one-click deep link
    // to the agents page so they don't have to hunt through menus —
    // the user's complaint "why are you asking me to do extra work
    // when you know where the fix is" is about exactly this.
    let ctaHtml = '';
    if (code === '401' || code === '403') {
      advice = 'The Krawler API rejected this agent key. The key is wrong, expired, or was rotated. Grab the current key from krawler.com and paste it into the <strong>Krawler agent key</strong> block.';
      ctaHtml = `<a href="https://krawler.com/agents/" target="_blank" rel="noopener" style="display:inline-block;margin:10px 0 0;padding:8px 16px;background:var(--brand);color:#fff;border-radius:9999px;font-weight:600;font-size:0.87rem;text-decoration:none;">Open krawler.com/agents ↗</a>`;
    } else if (code === '404') {
      advice = 'This agent no longer exists on krawler.com (deleted, or this key belongs to a different environment). Click Disconnect in the Krawler agent key block, then spawn or pick a different agent on krawler.com.';
      ctaHtml = `<a href="https://krawler.com/agents/" target="_blank" rel="noopener" style="display:inline-block;margin:10px 0 0;padding:8px 16px;background:var(--brand);color:#fff;border-radius:9999px;font-weight:600;font-size:0.87rem;text-decoration:none;">Open krawler.com/agents ↗</a>`;
    } else if (m) {
      advice = 'Check your network, then click Heartbeat to retry. If this keeps happening, the Krawler API may be degraded.';
    }
    return `
      <div class="inline-status err" style="font-weight:600;">GET /me failed</div>
      ${m ? `<pre style="background:#1c1f24;color:#ff8a8a;font-family:'SF Mono',Menlo,monospace;font-size:0.78rem;padding:8px 10px;border-radius:6px;margin:8px 0;overflow-x:auto;">${escapeHtml(m)}</pre>` : ''}
      ${advice ? `<div class="muted" style="font-size:0.85rem;">${advice}</div>` : ''}
      ${ctaHtml}
    `;
  }
  const avatarUrl = `https://api.dicebear.com/9.x/${encodeURIComponent(p.avatarStyle || 'bottts')}/svg?seed=${encodeURIComponent(p.handle)}`;
  const lastHb = p.lastHeartbeat
    ? `last heartbeat: ${new Date(p.lastHeartbeat).toLocaleString()}`
    : 'no heartbeat yet';
  const body = p.placeholder
    ? `<div class="inline-status warn">Placeholder handle. The next heartbeat will pick a real name, bio, and avatar. If this stays placeholder across a few cycles, check the activity log for <code>identity claim failed</code>.</div>`
    : `<div class="muted">${escapeHtml(p.displayName || '')}</div><div class="muted" style="font-size:0.8rem;">${escapeHtml(lastHb)}</div>`;
  return `
    <div style="display:flex;gap:12px;align-items:flex-start;">
      <img src="${avatarUrl}" style="width:48px;height:48px;border-radius:50%;background:var(--surface-3);flex-shrink:0;" alt="" />
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;">@${escapeHtml(p.handle)}</div>
        ${body}
      </div>
      <a href="https://krawler.com/agents/" target="_blank" style="font-size:0.82rem;white-space:nowrap;">Manage ↗</a>
    </div>
  `;
}

function renderDetailKrawlerKey(p, cfg) {
  const hasKey = cfg.hasKrawlerApiKey;
  const masked = cfg.krawlerApiKeyMasked ?? '';
  const editing = editMode.has(`krawler:${p.name}`);

  if (hasKey && !editing) {
    return `
      <div class="key-saved">
        <span>${escapeHtml(masked)}</span>
        <button type="button" class="link-btn" data-krawler-edit>Replace</button>
        <button type="button" class="link-btn" data-krawler-copy>Copy</button>
        <button type="button" class="link-btn danger" data-krawler-disconnect>Disconnect</button>
      </div>
      <span id="krawler-status" class="inline-status" style="margin-left:8px;"></span>
      <div class="hint">This key binds the local profile to your agent on krawler.com. Any harness that speaks the Krawler API can use the same key.</div>
    `;
  }

  return `
    <div class="key-row">
      <div class="key-input">
        <input id="krawler-input" type="password" placeholder="kra_live_…" autocomplete="off" spellcheck="false" />
        <button type="button" class="reveal" data-krawler-reveal>Show</button>
      </div>
      <button class="save-btn" data-krawler-save>${hasKey ? 'Save new key' : 'Save key'}</button>
      ${hasKey ? '<button type="button" class="secondary" data-krawler-cancel>Cancel</button>' : ''}
      <span id="krawler-status" class="inline-status"></span>
    </div>
    <div class="hint">Spawn one at <a href="https://krawler.com/agents/" target="_blank">krawler.com/agents</a>.</div>
  `;
}

function renderDetailRuntime(p, cfg) {
  // Only offer providers that actually have a saved key. The agent's
  // currently-saved provider is always included in the list (even if
  // its key was since removed) so the UI doesn't hide the "bad" choice
  // the agent is stuck on — but it's marked so the fix is obvious.
  const saved = new Set(savedProviderList());
  const currentMissing = !saved.has(cfg.provider);
  const choices = [...saved];
  if (currentMissing) choices.unshift(cfg.provider);

  const providerBtns = choices.map((prov) => {
    const cls = cfg.provider === prov ? 'active' : '';
    const unhealthy = prov === cfg.provider && currentMissing;
    const hint = unhealthy ? ' ⚠' : '';
    const title = unhealthy ? `This agent is set to ${prov}, but no ${prov} key is saved. Pick another provider below, or add a ${prov} key up top.` : '';
    return `<button type="button" class="${cls}" data-provider-pick="${prov}" title="${escapeAttr(title)}">${escapeHtml(PROVIDER_DEFS[prov].label)}${hint}</button>`;
  }).join('');

  // Inline key status line under the provider picker so the user never
  // has to scroll up to check whether "OpenRouter" actually has a key
  // saved — a common question when diagnosing a heartbeat failure.
  const currentDef = PROVIDER_DEFS[cfg.provider];
  let keyStatusHtml;
  if (currentDef.isUrl) {
    const url = sharedKeys?.ollamaBaseUrl ?? '';
    keyStatusHtml = `<span class="inline-status ok">✓ base URL: <code>${escapeHtml(url)}</code></span>`;
  } else {
    const masked = sharedKeys?.[currentDef.maskedKey] ?? '';
    const hasKey = Boolean(sharedKeys?.[currentDef.stateKey]);
    keyStatusHtml = hasKey
      ? `<span class="inline-status ok">✓ shared key saved: <code>${escapeHtml(masked)}</code></span>`
      : `<span class="inline-status err">✕ no ${escapeHtml(currentDef.label)} key saved</span>`;
  }

  const cadenceBtns = CADENCE_OPTIONS.map((c) => {
    const cls = cfg.cadenceMinutes === c.minutes ? 'active' : '';
    return `<button type="button" class="${cls}" data-cadence-pick="${c.minutes}">${escapeHtml(c.label)}</button>`;
  }).join('');

  // Model suggestions now render as clickable chips directly under the
  // input. The <datalist> is kept as a fallback for keyboard users but
  // the chips are the primary surface — datalist dropdowns are often
  // invisible until you type something, which was the user's complaint
  // "I can't select a model even".
  const suggestions = modelSuggestions[cfg.provider] ?? [];
  const suggestionChips = suggestions.length
    ? `<div class="seg" style="margin-top:6px;">${suggestions.map((m) => {
        const cls = (cfg.model ?? '') === m ? 'active' : '';
        return `<button type="button" class="${cls}" data-model-pick="${escapeAttr(m)}">${escapeHtml(m)}</button>`;
      }).join('')}</div>`
    : '';
  const datalistHtml = suggestions.length
    ? `<datalist id="detail-model-suggestions">${suggestions.map((m) => `<option value="${escapeAttr(m)}"></option>`).join('')}</datalist>`
    : '';

  const providerHint = choices.length <= 1
    ? `This agent uses <strong>${escapeHtml(PROVIDER_DEFS[cfg.provider].label)}</strong>. Add another provider's key at the top to switch.`
    : `Pick which provider this agent talks to. Shared keys are read from the Provider keys panel up top.`;

  return `
    <div style="display:grid;grid-template-columns:1fr;gap:14px;">
      <div>
        <label>Provider</label>
        <div class="seg">${providerBtns}</div>
        <div style="margin-top:8px;">${keyStatusHtml}</div>
        <div class="hint">${providerHint}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end;">
        <div>
          <label>Model ${suggestions.length ? '<small class="muted">click a suggestion or type</small>' : ''}</label>
          <input id="detail-model" type="text" value="${escapeAttr(cfg.model ?? '')}" list="detail-model-suggestions" placeholder="e.g. claude-opus-4-7" autocomplete="off" spellcheck="false" />
          ${datalistHtml}
          ${suggestionChips}
        </div>
        <button data-runtime-save>Save model</button>
      </div>
      <div>
        <label>Cadence <small>heartbeats run only while <code>krawler start</code> is in the foreground</small></label>
        <div class="seg">${cadenceBtns}</div>
      </div>
      <div>
        <label class="chk" style="background:var(--warn-bg);border-color:#e8c166;color:var(--warn);">
          <input type="checkbox" id="detail-dryrun" ${cfg.dryRun ? 'checked' : ''} />
          <strong>Dry run</strong>
          <span style="color:var(--warn);font-weight:400;">&nbsp;(log decisions, skip the API calls)</span>
        </label>
      </div>
      <span id="runtime-status" class="inline-status"></span>
    </div>
  `;
}

function wireAgentDetail(name) {
  // Close / retry controls on the detail panel itself. Must be wired
  // even when the config is missing so the user can always bail out.
  q('[data-detail-close]')?.addEventListener('click', () => closeDetail());
  q('[data-detail-retry]')?.addEventListener('click', async () => {
    try { await fetchProfileConfig(name); renderAgentsTable(); } catch (e) { alert(`Retry failed: ${e.message}`); }
  });

  // Krawler key actions
  q('[data-krawler-save]')?.addEventListener('click', () => saveKrawlerKey(name));
  q('[data-krawler-edit]')?.addEventListener('click', () => {
    editMode.add(`krawler:${name}`);
    renderAgentsTable();
    requestAnimationFrame(() => $('krawler-input')?.focus());
  });
  q('[data-krawler-cancel]')?.addEventListener('click', () => {
    editMode.delete(`krawler:${name}`);
    renderAgentsTable();
  });
  q('[data-krawler-copy]')?.addEventListener('click', () => copyKrawlerKey(name));
  q('[data-krawler-disconnect]')?.addEventListener('click', () => disconnectKrawlerKey(name));
  q('[data-krawler-reveal]')?.addEventListener('click', () => {
    const input = $('krawler-input');
    const btn = q('[data-krawler-reveal]');
    if (!input) return;
    if (input.type === 'password') { input.type = 'text'; btn.textContent = 'Hide'; }
    else { input.type = 'password'; btn.textContent = 'Show'; }
  });
  $('krawler-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveKrawlerKey(name); }
  });

  // Provider picker
  document.querySelectorAll('[data-provider-pick]').forEach((b) => {
    b.addEventListener('click', () => {
      const prov = b.getAttribute('data-provider-pick');
      saveRuntimePatch(name, { provider: prov });
    });
  });
  // "adding its key" link in the provider-picker hint scrolls back up
  // to the shared keys pane and opens the + Add provider flow.
  q('[data-scroll-to-keys]')?.addEventListener('click', (e) => {
    e.preventDefault();
    // Pick the first unsaved provider as the default for the add flow.
    const saved = new Set(savedProviderList());
    const firstUnsaved = PROVIDER_ORDER.find((p) => !saved.has(p));
    if (firstUnsaved) addingProvider = firstUnsaved;
    renderSharedKeys();
    $('shared-keys-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (firstUnsaved) requestAnimationFrame(() => $(`shared-input-${firstUnsaved}`)?.focus());
  });
  // Cadence picker
  document.querySelectorAll('[data-cadence-pick]').forEach((b) => {
    b.addEventListener('click', () => {
      const mins = Number(b.getAttribute('data-cadence-pick'));
      saveRuntimePatch(name, { cadenceMinutes: mins });
    });
  });
  // Dry-run toggle
  $('detail-dryrun')?.addEventListener('change', (e) => {
    saveRuntimePatch(name, { dryRun: e.target.checked });
  });
  // Model input save button
  q('[data-runtime-save]')?.addEventListener('click', () => {
    const model = $('detail-model')?.value?.trim() ?? '';
    saveRuntimePatch(name, { model });
  });
  $('detail-model')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRuntimePatch(name, { model: e.target.value.trim() });
    }
  });
  // Model suggestion chips: click-to-pick-and-save. Faster than typing
  // the full slug, and visible from the first render so the user never
  // has to wonder whether suggestions exist.
  document.querySelectorAll('[data-model-pick]').forEach((b) => {
    b.addEventListener('click', () => {
      const model = b.getAttribute('data-model-pick');
      const input = $('detail-model');
      if (input) input.value = model;
      saveRuntimePatch(name, { model });
    });
  });

  // Logs toggle
  q('[data-logs-toggle]')?.addEventListener('click', async () => {
    logsVisible = !logsVisible;
    renderAgentsTable();
    if (logsVisible) await refreshDetailLogs();
  });
}

async function saveKrawlerKey(name) {
  const status = $('krawler-status');
  const val = $('krawler-input')?.value ?? '';
  if (!val) { setStatus(status, 'paste a key first', 'warn', 1800); return; }
  setStatus(status, 'saving…');
  try {
    await api(`/api/config?profile=${encodeURIComponent(name)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ krawlerApiKey: val }),
    });
    setStatus(status, 'saved ✓', 'ok', 1800);
    editMode.delete(`krawler:${name}`);
    await fetchProfileConfig(name);
    await fetchProfiles();
    renderAgentsTable();
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
  }
}

async function copyKrawlerKey(name) {
  const status = $('krawler-status');
  try {
    const j = await api(`/api/agent/reveal-key?profile=${encodeURIComponent(name)}`);
    await navigator.clipboard.writeText(j.key);
    setStatus(status, 'copied ✓', 'ok', 1800);
  } catch (e) {
    setStatus(status, `copy failed: ${e.message}`, 'err');
  }
}

async function disconnectKrawlerKey(name) {
  if (!confirm(`Disconnect profile "${name}"? Your agent on krawler.com is untouched; you can paste the key again any time.`)) return;
  try {
    await api(`/api/agent?profile=${encodeURIComponent(name)}`, { method: 'DELETE' });
    await fetchProfileConfig(name);
    await fetchProfiles();
    renderAgentsTable();
  } catch (e) {
    alert(`Disconnect failed: ${e.message}`);
  }
}

async function saveRuntimePatch(name, patch) {
  const status = $('runtime-status');
  setStatus(status, 'saving…');
  try {
    await api(`/api/config?profile=${encodeURIComponent(name)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    setStatus(status, 'saved ✓', 'ok', 1500);
    await fetchProfileConfig(name);
    await fetchProfiles();
    renderAgentsTable();
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
  }
}

async function refreshDetailLogs() {
  if (!selectedProfile) return;
  const host = q('#detail-logs .logs');
  if (!host) return;
  try {
    const j = await api(`/api/log?profile=${encodeURIComponent(selectedProfile)}&limit=30`);
    const lines = Array.isArray(j.log) ? j.log : [];
    if (!lines.length) {
      host.innerHTML = `<div class="empty">(no activity yet)</div>`;
      return;
    }
    host.innerHTML = lines.reverse().map((e) => {
      const ts = new Date(e.ts).toLocaleTimeString();
      return `<div class="line ${escapeAttr(e.level)}">[${escapeHtml(ts)}] ${escapeHtml(e.level.padEnd(5))} ${escapeHtml(e.msg)}</div>`;
    }).join('');
  } catch (e) {
    host.innerHTML = `<div class="empty">could not load logs: ${escapeHtml(e.message)}</div>`;
  }
}

// ───────────────────────── Installed skills (scoped to expanded agent) ─────────────────────────

async function fetchInstalledSkills(name) {
  if (!name) { $('skills-card').style.display = 'none'; return; }
  const mount = $('installed-skills');
  $('skills-card').style.display = '';
  $('skills-scope').textContent = `— for @${profiles.find((p) => p.name === name)?.handle ?? name}`;
  pendingSkillsProfile = name;
  try {
    const j = await api(`/api/installed-skills?profile=${encodeURIComponent(name)}`);
    if (pendingSkillsProfile !== name) return; // raced by a profile switch
    renderInstalledSkills(j.skills || []);
  } catch (e) {
    mount.innerHTML = `<div class="inline-status err">Failed to load installed skills: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

function renderInstalledSkills(skills) {
  const mount = $('installed-skills');
  if (!mount) return;
  if (!skills.length) {
    mount.innerHTML = `<div class="muted">No skills installed on this profile yet. Install one from <a href="https://krawler.com/agents/" target="_blank">krawler.com/agents</a>; the body lands here on the next heartbeat.</div>`;
    return;
  }
  const rows = skills.map((s) => {
    const title = s.title || s.slug;
    const edited = s.edited
      ? `<span class="pill warn">edited</span>`
      : `<span class="pill ok">clean</span>`;
    const originHtml = s.origin
      ? `<a href="${escapeAttr(s.origin)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.origin)}</a>`
      : '<span class="muted">(origin unknown)</span>';
    const syncTime = s.lastSyncedAt ? `last synced ${relTimeShort(s.lastSyncedAt)}` : 'never synced';
    return `
      <details style="border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-bottom:8px;background:var(--surface);">
        <summary style="cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <strong style="font-size:0.95rem;">${escapeHtml(title)}</strong>
          <code style="font-size:0.75rem;">${escapeHtml(s.slug)}</code>
          ${edited}
          <span class="muted" style="font-size:0.78rem;">${s.bodyBytes}B · ${escapeHtml(syncTime)}</span>
        </summary>
        <div style="margin-top:10px;">
          <div class="hint" style="margin-bottom:6px;">Origin: ${originHtml}</div>
          <textarea readonly data-skill-body="${escapeAttr(s.slug)}" style="width:100%;min-height:220px;padding:10px 12px;background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);border-radius:6px;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:0.82rem;line-height:1.5;">${escapeHtml(s.body || '')}</textarea>
          <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap;">
            <button type="button" class="secondary small" data-skill-copy="${escapeAttr(s.slug)}">Copy body</button>
            <a class="secondary" href="${escapeAttr(s.origin || '#')}" target="_blank" rel="noopener noreferrer" style="padding:4px 10px;background:var(--surface-2);color:var(--text-1);border:1px solid var(--border-2);border-radius:9999px;font-weight:500;text-decoration:none;font-size:0.78rem;">Open origin</a>
            <button type="button" class="secondary small" data-skill-sync="${escapeAttr(s.slug)}">Re-sync</button>
            <span class="muted" data-skill-status="${escapeAttr(s.slug)}" style="font-size:0.78rem;"></span>
          </div>
        </div>
      </details>
    `;
  });
  mount.innerHTML = rows.join('');
}

async function copySkillBody(slug) {
  const ta = document.querySelector(`textarea[data-skill-body="${CSS.escape(slug)}"]`);
  const status = document.querySelector(`[data-skill-status="${CSS.escape(slug)}"]`);
  if (!ta) return;
  try {
    await navigator.clipboard.writeText(ta.value);
  } catch {
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
  }
  if (status) { status.textContent = 'copied ✓'; setTimeout(() => { status.textContent = ''; }, 1500); }
}

async function syncSkill(slug) {
  if (!selectedProfile) return;
  const status = document.querySelector(`[data-skill-status="${CSS.escape(slug)}"]`);
  const setLine = (txt, cls) => { if (status) { status.textContent = txt; status.className = `muted ${cls || ''}`.trim(); } };
  setLine('syncing…');
  try {
    let r = await fetch(`/api/installed-skills/${encodeURIComponent(slug)}/sync?profile=${encodeURIComponent(selectedProfile)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (r.status === 409) {
      if (!confirm(`Local copy of "${slug}" has diverged. Re-syncing will overwrite your local edits. Continue?`)) { setLine('cancelled', 'warn'); return; }
      r = await fetch(`/api/installed-skills/${encodeURIComponent(slug)}/sync?profile=${encodeURIComponent(selectedProfile)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }),
      });
    }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    const j = await r.json();
    setLine(j.overwroteLocalEdits ? 'synced (overwrote edits)' : j.changed ? 'synced (body changed)' : 'synced (no changes)', 'ok');
    await fetchInstalledSkills(selectedProfile);
  } catch (e) {
    setLine(`failed: ${e.message}`, 'err');
  }
}

// ───────────────────────── Helpers ─────────────────────────

function setStatus(el, text, kind = 'muted', autoClearMs = 0) {
  if (!el) return;
  el.textContent = text;
  el.className = 'inline-status ' + (kind === 'muted' ? '' : kind);
  if (autoClearMs) {
    setTimeout(() => {
      if (el.textContent === text) { el.textContent = ''; el.className = 'inline-status'; }
    }, autoClearMs);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function relTimeShort(iso) {
  if (!iso) return '?';
  const d = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ───────────────────────── Refresh cycle ─────────────────────────

async function refreshAll({ skipSharedKeys = false, skipModelSuggestions: _skipSuggestions = false } = {}) {
  await Promise.all([
    fetchProfiles(),
    skipSharedKeys ? Promise.resolve() : fetchSharedKeys(),
    selectedProfile ? fetchProfileConfig(selectedProfile) : Promise.resolve(),
  ]);
  const facts = $('install-facts');
  if (facts) facts.textContent = profiles.length > 1 ? `· ${profiles.length} profiles` : '';
  renderSharedKeys();
  renderAgentsTable();
}

// ───────────────────────── Boot ─────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  $('btn-add-agent')?.addEventListener('click', addAgent);

  // Escape from anywhere on the page closes the detail panel. Matches
  // what most modal/expandable UIs do and means the user never needs to
  // hunt for a close button when they just want to back out.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectedProfile) {
      // Skip when focus is in an input so typing "Escape" while cancelling
      // inline editing doesn't also collapse the detail. A blur on the
      // input is the native behaviour there.
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      closeDetail();
    }
  });

  // Skills panel delegated handlers. Skills are loaded only for the
  // selected profile, so these live on document and dispatch via data-*.
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-skill-copy]');
    if (copyBtn) { void copySkillBody(copyBtn.getAttribute('data-skill-copy')); return; }
    const syncBtn = e.target.closest('[data-skill-sync]');
    if (syncBtn) { void syncSkill(syncBtn.getAttribute('data-skill-sync')); return; }
  });

  // Initial load: profiles + shared keys are needed to render anything
  // meaningful, so block the first paint on both.
  refreshAll().catch((e) => {
    console.error('initial refresh failed', e);
    $('shared-keys-body').innerHTML = `<div class="inline-status err">Could not reach the local server. Is <code>krawler start</code> running?</div>`;
  });

  // Polling: profiles + shared keys at 15s; the detail row's config and
  // logs are only refreshed when actions happen or the user opens the log
  // panel, to avoid clobbering in-progress typing in the model field.
  setInterval(() => { refreshAll().catch(() => {}); }, 15000);
});
