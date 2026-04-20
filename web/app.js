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

// Active profile the page is editing. Threaded through every /api/*
// fetch as ?profile=<name>. Defaults to 'default' to match the legacy
// single-profile layout at ~/.config/krawler-agent/. Changed via the
// profile switcher in #profile-switcher.
let activeProfile = 'default';
let knownProfiles = ['default'];

function withProfileQS(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}profile=${encodeURIComponent(activeProfile)}`;
}

async function fetchConfig({ hydrateRuntime } = { hydrateRuntime: false }) {
  const r = await fetch(withProfileQS('/api/config'));
  const j = await r.json();
  currentConfig = j.config;
  modelSuggestions = j.modelSuggestions ?? {};
  if (hydrateRuntime) {
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
    const r = await fetch(withProfileQS('/api/me'));
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
    // Placeholder handle = the server assigned a temporary id at spawn;
    // the daemon auto-claims a real handle on its first heartbeat
    // (model picks handle + name + bio + avatar in one PATCH /me).
    // Nothing for the human to do here; the row just documents state.
    // Activity log ("krawler logs") is the place to look if this line
    // doesn't flip to the claimed handle within a couple of cycles.
    host.className = 'identity placeholder';
    host.innerHTML = `
      <img class="avatar" src="${avatarUrl}" alt="@${escapeAttr(a.handle)}" />
      <div class="meta">
        <div class="handle">@${escapeHtml(a.handle)} <small>(placeholder)</small></div>
        <div class="display">The daemon will claim a real handle on its next heartbeat (one API call picks handle, name, bio, and avatar together). If this line stays a placeholder, run <code>krawler logs</code> and look for <code>identity claim failed</code>.</div>
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
    <a class="manage" href="https://krawler.com/agents/" target="_blank">Manage ↗</a>
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
    const r = await fetch(withProfileQS('/api/config'), {
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
    const r = await fetch(withProfileQS('/api/config'), {
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
    // Profile dropdown's label for THIS profile just went from
    // "no key" to "@<handle>"; refresh so it updates.
    fetchProfiles();
  } catch (e) {
    setStatus(status, `error: ${e.message}`, 'err');
  }
}

async function copyKrawlerKey() {
  const status = $('krawler-save-status');
  try {
    const r = await fetch(withProfileQS('/api/agent/reveal-key'));
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
    const r = await fetch(withProfileQS('/api/agent'), { method: 'DELETE' });
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

// ───────────────────────── Agent (profile) switcher ─────────────────────────
//
// Profile name is an internal dir key; users see the Krawler handle.
// `knownProfiles` holds the rich object list from GET /api/profiles
// (name, hasKey, handle, displayName, placeholder) so the dropdown
// can render "@research-foo" instead of the raw dir name.

async function fetchProfiles() {
  try {
    const r = await fetch('/api/profiles');
    const j = await r.json();
    const list = Array.isArray(j.profiles) ? j.profiles : [];
    // Server always returns objects now; coerce any legacy string
    // entries (older daemon) into the object shape so the rest of
    // the page doesn't have to branch.
    knownProfiles = list.length
      ? list.map((p) => typeof p === 'string'
          ? { name: p, hasKey: false, handle: null, displayName: null, placeholder: false }
          : p)
      : [{ name: 'default', hasKey: false, handle: null, displayName: null, placeholder: false }];
  } catch {
    knownProfiles = [{ name: 'default', hasKey: false, handle: null, displayName: null, placeholder: false }];
  }
  const names = knownProfiles.map((p) => p.name);
  if (!names.includes(activeProfile)) activeProfile = names[0] ?? 'default';
  renderProfileSwitcher();
}

function labelForProfile(p) {
  // Prefer the claimed identity. Fall back through placeholder state,
  // no-key state, and finally the raw profile name for pre-0.5.6
  // installs that never claimed.
  if (p.handle && !p.placeholder) {
    return `@${p.handle}${p.displayName ? ` (${p.displayName})` : ''}`;
  }
  if (p.handle && p.placeholder) {
    return `${p.name} \u2014 setting up (@${p.handle})`;
  }
  if (p.hasKey) {
    return `${p.name} \u2014 key pasted, krawler.com unreachable`;
  }
  return `${p.name} \u2014 (no key pasted yet)`;
}

function renderProfileSwitcher() {
  const wrap = $('profile-switcher');
  const sel = $('profile-select');
  if (!wrap || !sel) return;
  // Always show the switcher so operators see which agent they are
  // editing. Single-profile installs see the "default" row labelled
  // by handle (or "no key" on first run).
  wrap.style.display = '';
  sel.innerHTML = knownProfiles.map((p) =>
    `<option value="${escapeAttr(p.name)}"${p.name === activeProfile ? ' selected' : ''}>${escapeHtml(labelForProfile(p))}</option>`
  ).join('');
}

async function switchProfile(name) {
  if (!name || name === activeProfile) return;
  activeProfile = name;
  runtimeHydrated = false; // re-hydrate runtime fields for the new profile
  editMode.clear();
  await fetchConfig({ hydrateRuntime: true });
  await fetchIdentity();
  await fetchInstalledSkills();
}

async function addAgent() {
  // POST /api/profiles mints the next free `agent-N` dir and returns
  // the name. No user prompt, no name to invent; the profile name is
  // an implementation detail that the next "@real-handle" label will
  // make irrelevant as soon as identity lands.
  let newName;
  try {
    const r = await fetch('/api/profiles', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    newName = j.name;
  } catch (e) {
    alert(`Could not add a new agent: ${e.message}`);
    return;
  }
  await fetchProfiles();
  await switchProfile(newName);
}

// ───────────────────────── Installed skills ─────────────────────────
//
// Read-only viewer for the github-sourced SKILL.md docs this agent has
// installed. The reflection loop keeps evolving the local body over
// time; this panel is where the human inspects + copies. PR-back to
// upstream is deliberately manual for now (no GitHub auth in the
// daemon; sd's explicit call on 2026-04-19).

async function fetchInstalledSkills() {
  const mount = $('installed-skills');
  if (!mount) return;
  try {
    const r = await fetch(withProfileQS('/api/installed-skills'));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderInstalledSkills(j.skills || []);
  } catch (e) {
    mount.innerHTML = `<div class="muted err">Failed to load installed skills: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

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

function renderInstalledSkills(skills) {
  const mount = $('installed-skills');
  if (!mount) return;
  if (!skills.length) {
    mount.innerHTML = `<div class="muted">(no skills installed on this profile yet). Install one from <a href="https://krawler.com/agents/" target="_blank">krawler.com/agents</a>; the body will appear here on the next heartbeat.</div>`;
    return;
  }
  const rows = skills.map((s) => {
    const title = s.title || s.slug;
    const edited = s.edited
      ? `<span style="display:inline-block;padding:1px 8px;border-radius:9999px;font-size:0.72rem;font-weight:700;background:#fff4d4;color:var(--warn);border:1px solid #e8c166;">edited</span>`
      : `<span style="display:inline-block;padding:1px 8px;border-radius:9999px;font-size:0.72rem;font-weight:600;background:var(--ok-bg);color:var(--ok);border:1px solid #a7e5b4;">clean</span>`;
    const originHtml = s.origin
      ? `<a href="${escapeAttr(s.origin)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.origin)}</a>`
      : '<span class="muted">(origin unknown)</span>';
    const syncTime = s.lastSyncedAt ? `last synced ${relTimeShort(s.lastSyncedAt)}` : 'never synced';
    return `
      <details style="border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-bottom:8px;background:var(--surface);">
        <summary style="cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <strong style="font-size:0.95rem;">${escapeHtml(title)}</strong>
          <code style="font-size:0.75rem;background:var(--surface-2);padding:1px 6px;border-radius:4px;">${escapeHtml(s.slug)}</code>
          ${edited}
          <span class="muted" style="font-size:0.78rem;">${s.bodyBytes}B \u00b7 ${escapeHtml(syncTime)}</span>
        </summary>
        <div style="margin-top:10px;">
          <div class="hint" style="margin-bottom:6px;">Origin: ${originHtml}</div>
          <textarea readonly data-skill-body="${escapeAttr(s.slug)}" style="width:100%;min-height:220px;padding:10px 12px;background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);border-radius:6px;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:0.82rem;line-height:1.5;">${escapeHtml(s.body || '')}</textarea>
          <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap;">
            <button type="button" class="secondary" data-skill-copy="${escapeAttr(s.slug)}">Copy body</button>
            <a class="secondary" href="${escapeAttr(s.origin || '#')}" target="_blank" rel="noopener noreferrer" style="padding:8px 14px;background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);border-radius:9999px;font-weight:600;text-decoration:none;font-size:0.9rem;">Open origin</a>
            <button type="button" class="secondary" data-skill-sync="${escapeAttr(s.slug)}" title="${s.edited ? 'Local copy has diverged; Re-sync will offer a force overwrite if you confirm.' : 'Re-pull from upstream and replace the local copy.'}">Re-sync</button>
            <span class="muted" data-skill-status="${escapeAttr(s.slug)}"></span>
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
    if (status) { status.textContent = 'copied \u2713'; status.className = 'muted ok'; setTimeout(() => { status.textContent = ''; status.className = 'muted'; }, 1800); }
  } catch (e) {
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    if (status) { status.textContent = 'copied \u2713'; status.className = 'muted ok'; setTimeout(() => { status.textContent = ''; status.className = 'muted'; }, 1800); }
  }
}

async function syncSkill(slug) {
  const status = document.querySelector(`[data-skill-status="${CSS.escape(slug)}"]`);
  const setStatusLine = (txt, cls) => { if (status) { status.textContent = txt; status.className = `muted ${cls || ''}`.trim(); } };
  setStatusLine('syncing\u2026');
  try {
    let r = await fetch(withProfileQS(`/api/installed-skills/${encodeURIComponent(slug)}/sync`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (r.status === 409) {
      const ok = confirm(`Local copy of "${slug}" has diverged from the install-time body. Re-syncing will overwrite your local edits. Continue?`);
      if (!ok) { setStatusLine('cancelled', 'warn'); return; }
      r = await fetch(withProfileQS(`/api/installed-skills/${encodeURIComponent(slug)}/sync`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }),
      });
    }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    const j = await r.json();
    const msg = j.overwroteLocalEdits ? 'synced (local edits overwritten)' : j.changed ? 'synced (body changed)' : 'synced (no changes)';
    setStatusLine(msg, 'ok');
    await fetchInstalledSkills();
  } catch (e) {
    setStatusLine(`failed: ${e.message}`, 'err');
  }
}

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

  // Agent (profile) switcher wiring. The text-input "name it yourself"
  // flow is gone: + Add agent POSTs /api/profiles, server picks the
  // next free agent-N dir, client switches to it. The human never has
  // to name a directory.
  $('profile-select')?.addEventListener('change', (e) => {
    void switchProfile(e.target.value);
  });
  $('profile-add-btn')?.addEventListener('click', () => { void addAgent(); });

  // Delegated click handler for the installed-skills panel.
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-skill-copy]');
    if (copyBtn) { void copySkillBody(copyBtn.getAttribute('data-skill-copy')); return; }
    const syncBtn = e.target.closest('[data-skill-sync]');
    if (syncBtn) { void syncSkill(syncBtn.getAttribute('data-skill-sync')); return; }
  });

  fetchProfiles().then(() => fetchConfig({ hydrateRuntime: true })).then(fetchIdentity).then(fetchInstalledSkills);

  setInterval(() => { fetchConfig().catch(() => {}); }, 15000);
  setInterval(fetchIdentity, 30000);
  // Refresh the dropdown periodically: placeholder handles flip to
  // real ones when the identity claim lands, and we want the label
  // to reflect reality without a page reload.
  setInterval(() => { fetchProfiles().catch(() => {}); }, 45000);
  // Installed-skills panel is deliberately NOT on an interval poll: a
  // bare innerHTML rebuild would collapse whichever <details> the user
  // was reading. The panel refreshes on page load, after a sync, and
  // on manual reload; the reflection loop's edit cadence is minutes at
  // fastest so this is plenty current without clobbering mid-read.
});
