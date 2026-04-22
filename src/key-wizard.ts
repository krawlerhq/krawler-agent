// Local one-page HTML wizard for provider keys + active-model picker.
//
// Why this exists: provider API keys (Anthropic/OpenAI/Google/OpenRouter,
// plus the Ollama base URL) live in ~/.config/krawler-agent/shared-keys.json.
// Storing them locally is the right call — krawler.com never sees them,
// which keeps the privacy promise intact. But hand-editing JSON to paste
// a fresh sk-ant-... every time is not a first-run UX we want. Same
// story for "which model is this agent talking to right now": Opus 4.7
// is expensive, OpenRouter has 100s of cheaper alternatives, and forcing
// the user to type slugs from memory doesn't respect their time.
//
// So: the CLI spawns a tiny HTTP server on 127.0.0.1:4242 and serves
// one self-contained HTML page with (a) provider + model selectors,
// (b) key inputs. For OpenRouter the model <select> is populated live
// from https://openrouter.ai/api/v1/models (proxied through this
// server, cached 1 hour) so the full catalogue is one click away.
// User clicks Save, we write shared-keys.json + the active profile's
// config.json, page self-closes.
//
// Scope is DELIBERATELY still tight. This is NOT the 0.6.0 settings
// dashboard coming back — runtime config like cadence, dry-run,
// behaviour toggles stays on krawler.com/agent/<handle>/settings.
// Only provider/model lives here because you cannot pick a model
// without also having a key for that model's provider; coupling them
// in one form makes "paste key + pick model + go" one motion.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import open from 'open';

import { loadConfig, loadSharedKeys, normalizeModelForProvider, PROVIDERS, saveConfig, saveSharedKeys } from './config.js';
import type { Provider, SharedKeys } from './config.js';
import { CURATED_OPENROUTER_MODELS, MODEL_SUGGESTIONS } from './model.js';
import { listProfiles, withProfile } from './profile-context.js';

export interface WizardResult {
  saved: boolean;
  keys: SharedKeys;
  url: string;
}

// Preferred fixed ports for the key wizard. 4242 is the canonical, stable,
// bookmarkable URL; 4243 and 4244 are fallbacks for the rare case of two
// concurrent CLIs on one machine. Dropping to an OS-picked random port is
// the final fallback so parallel installs never deadlock. Documenting 4242
// lets a user who missed the auto-opened tab just type
// http://127.0.0.1:4242 to get back to the form.
export const PREFERRED_WIZARD_PORTS = [4242, 4243, 4244] as const;

// Render the wizard HTML. All styles inline so a user doesn't need
// krawler.com reachable to see a polished page. Existing keys render
// as placeholders (masked) so the user knows which slots are already
// set — they can leave those blank to keep them. The active provider
// and model come from the CURRENT profile's config.json so the form
// opens on whatever the agent is actively using right now.
function renderPage(existing: SharedKeys, activeProvider: Provider, activeModel: string, activeProfile: string, profileCount: number): string {
  const mask = (k: string): string => {
    if (!k) return '';
    if (k.length < 10) return '\u2022\u2022\u2022\u2022\u2022';
    return k.slice(0, 6) + '\u2022\u2022\u2022\u2022\u2022\u2022' + k.slice(-4);
  };
  const fields = [
    { id: 'anthropicApiKey', label: 'Anthropic', placeholder: 'sk-ant-...', value: existing.anthropicApiKey, existing: mask(existing.anthropicApiKey) },
    { id: 'openaiApiKey', label: 'OpenAI', placeholder: 'sk-...', value: existing.openaiApiKey, existing: mask(existing.openaiApiKey) },
    { id: 'googleApiKey', label: 'Google', placeholder: 'AIza...', value: existing.googleApiKey, existing: mask(existing.googleApiKey) },
    { id: 'openrouterApiKey', label: 'OpenRouter', placeholder: 'sk-or-v1-...', value: existing.openrouterApiKey, existing: mask(existing.openrouterApiKey) },
  ];
  const fieldHtml = fields.map((f) => `
    <div class="row">
      <label for="${f.id}">${f.label} key</label>
      <input type="password" id="${f.id}" name="${f.id}" autocomplete="off" placeholder="${f.existing || f.placeholder}" />
      ${f.existing ? `<div class="hint">currently: <code>${f.existing}</code> \u00b7 leave blank to keep</div>` : ''}
    </div>
  `).join('');
  const providerOptions = PROVIDERS
    .map((p) => `<option value="${p}"${p === activeProvider ? ' selected' : ''}>${providerLabel(p)}</option>`)
    .join('');
  // The model <select> is rebuilt client-side whenever the provider
  // changes. We seed it with the active model as a single option so the
  // form is valid even before the JS hydration runs (and so "Save"
  // without touching anything is a true no-op on model).
  const fallbackMap = JSON.stringify(MODEL_SUGGESTIONS);
  const curatedOpenrouter = JSON.stringify(CURATED_OPENROUTER_MODELS);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Krawler \u2014 provider keys</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: #f6f7f9;
      --surface: #ffffff;
      --border: #e5e7eb;
      --text: #111827;
      --text-2: #4b5563;
      --text-3: #9ca3af;
      --brand: #2563eb;
      --brand-dark: #1d4ed8;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 56px 20px; line-height: 1.5; }
    .card { max-width: 640px; margin: 0 auto; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 40px 44px; box-shadow: 0 6px 24px rgba(15,23,42,0.05); }
    @media (max-width: 560px) { .card { padding: 28px 22px; border-radius: 12px; } body { padding: 24px 12px; } }
    h1 { font-size: 1.5rem; margin: 0 0 10px; font-weight: 700; letter-spacing: -0.01em; }
    .sub { color: var(--text-2); font-size: 0.95rem; margin: 0 0 32px; line-height: 1.55; }
    .row { margin-bottom: 22px; }
    .row:last-child { margin-bottom: 0; }
    label { display: block; font-weight: 600; font-size: 0.82rem; margin-bottom: 6px; color: var(--text-2); }
    input[type=password], input[type=text], input[type=url], select { width: 100%; padding: 11px 14px; border: 1px solid var(--border); border-radius: 10px; font: inherit; font-size: 0.95rem; background: var(--surface); font-family: var(--mono); color: var(--text); }
    select { cursor: pointer; appearance: none; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M3 4.5L6 7.5 9 4.5' stroke='%236b7280' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>"); background-repeat: no-repeat; background-position: right 14px center; padding-right: 36px; }
    input:focus, select:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(37,99,235,0.18); }
    .section { padding-top: 28px; margin-top: 28px; border-top: 1px solid var(--border); }
    .section:first-of-type { padding-top: 0; margin-top: 0; border-top: none; }
    h2 { font-size: 0.74rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin: 0 0 16px; }
    .checkline { margin-top: 16px; }
    .check { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; font-weight: 500; font-size: 0.88rem; color: var(--text-2); text-transform: none; letter-spacing: 0; margin-bottom: 0; line-height: 1.45; }
    .check input { margin-top: 3px; accent-color: var(--brand); }
    .check code { font-family: var(--mono); background: var(--bg); padding: 0 5px; border-radius: 4px; font-size: 0.82rem; }
    .hint { font-size: 0.78rem; color: var(--text-3); margin-top: 6px; line-height: 1.5; }
    .hint code { background: var(--bg); padding: 1px 5px; border-radius: 4px; font-family: var(--mono); font-size: 0.72rem; }
    .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--border); }
    button { font: inherit; font-size: 0.92rem; font-weight: 600; padding: 10px 22px; border-radius: 9999px; border: none; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
    .primary { background: var(--brand); color: #fff; }
    .primary:hover { background: var(--brand-dark); }
    .secondary { background: var(--surface); color: var(--text-2); border: 1px solid var(--border); }
    .secondary:hover { border-color: var(--text-3); color: var(--text); }
    .status { font-size: 0.85rem; color: var(--text-3); margin-top: 18px; min-height: 1.3em; text-align: center; line-height: 1.5; }
    .status.err { color: #b91c1c; }
    .status.ok { color: #166534; }
    footer { text-align: center; font-size: 0.78rem; color: var(--text-3); margin-top: 20px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Krawler \u2014 agent settings</h1>
    <p class="sub">Pick the model your agent talks to, and paste the key for that provider. Keys never leave this machine (they write to <code style="font-family:var(--mono);">~/.config/krawler-agent/shared-keys.json</code>). Model choice is saved per profile (currently <code>${activeProfile}</code>).</p>
    <!-- method=post is belt-and-suspenders: even if the JS handler
         somehow no-ops, native submission won't dump the keys into a
         GET query string (which is what happened in 0.10.0 because the
         JS function was named 'submit', colliding with HTMLFormElement.submit). -->
    <form id="keyForm" method="post" action="/save" autocomplete="off">
      <div class="section">
        <h2>Active model</h2>
        <div class="row">
          <label for="provider">Provider</label>
          <select id="provider" name="provider">${providerOptions}</select>
        </div>
        <div class="row">
          <label for="model">Model</label>
          <select id="model" name="model"><option value="${escapeHtml(activeModel)}" selected>${escapeHtml(activeModel) || '(pick a provider first)'}</option></select>
          <div class="hint" id="modelHint">OpenRouter has 300+ models; the dropdown shows a curated top 10 across frontier, balanced and fast tiers. Custom slugs still work; edit <code>config.json</code> for anything not listed.</div>
        </div>
        ${profileCount > 1 ? `
        <div class="row checkline">
          <label class="check">
            <input type="checkbox" id="applyAll" name="applyAll" value="1" />
            <span>Apply provider + model to all ${profileCount} local profiles (not just <code>${activeProfile}</code>). Keys are always shared.</span>
          </label>
        </div>` : ''}
      </div>

      <div class="section">
        <h2>API keys</h2>
        ${fieldHtml}
        <div class="row">
          <label for="ollamaBaseUrl">Ollama base URL</label>
          <input type="url" id="ollamaBaseUrl" name="ollamaBaseUrl" placeholder="${existing.ollamaBaseUrl || 'http://localhost:11434'}" value="${existing.ollamaBaseUrl && existing.ollamaBaseUrl !== 'http://localhost:11434' ? existing.ollamaBaseUrl : ''}" />
          <div class="hint">default: <code>http://localhost:11434</code>. Only change if you run Ollama elsewhere.</div>
        </div>
      </div>

      <div class="actions">
        <button type="button" class="secondary" id="skipBtn">Skip</button>
        <button type="submit" class="primary" id="saveBtn">Save</button>
      </div>
    </form>
    <div class="status" id="status"></div>
    <footer>This page is served by your local <code>krawler</code> process. Come back to <code>http://127.0.0.1:4242/</code> any time (or type <code>/keys</code> in the chat) to rotate keys or switch models.</footer>
  </div>
  <script>
    // Handlers attached via addEventListener rather than inline
    // onsubmit/onclick so no variable name can shadow them. The
    // 0.10.0 bug was calling a function we called 'submit' from an
    // inline onsubmit; that name resolves to form.submit() first,
    // which fires a native GET and dumps the keys in the URL bar.
    (function () {
      const form = document.getElementById('keyForm');
      const skipBtn = document.getElementById('skipBtn');
      const status = document.getElementById('status');
      const providerSel = document.getElementById('provider');
      const modelSel = document.getElementById('model');
      const modelHint = document.getElementById('modelHint');
      const FALLBACK = ${fallbackMap};
      const CURATED_OPENROUTER = ${curatedOpenrouter};
      const ACTIVE_MODEL = ${JSON.stringify(activeModel)};
      function setStatus(msg, kind) {
        status.className = 'status' + (kind ? ' ' + kind : '');
        status.textContent = msg;
      }
      function fmtPrice(p) {
        // Openrouter prices are string USD per token; convert to per 1M.
        const n = Number(p);
        if (!Number.isFinite(n) || n <= 0) return 'free';
        return '$' + (n * 1e6).toFixed(2) + '/M';
      }
      // items is a flat list of { id, label, group? }. When any item
      // carries a group, <optgroup> headers are emitted in declared
      // order so the wizard can surface "Frontier / Balanced / Fast /
      // Specialized" tiers without requiring every renderer to know
      // the grouping scheme.
      function setOptions(items, selected) {
        modelSel.innerHTML = '';
        const hasGroups = items.some(function (it) { return it.group; });
        if (!hasGroups) {
          for (const it of items) {
            const opt = document.createElement('option');
            opt.value = it.id;
            opt.textContent = it.label;
            if (it.id === selected) opt.selected = true;
            modelSel.appendChild(opt);
          }
        } else {
          const order = [];
          const groupNodes = {};
          for (const it of items) {
            const g = it.group || 'Other';
            if (!groupNodes[g]) {
              const og = document.createElement('optgroup');
              og.label = g;
              groupNodes[g] = og;
              order.push(g);
            }
            const opt = document.createElement('option');
            opt.value = it.id;
            opt.textContent = it.label;
            if (it.id === selected) opt.selected = true;
            groupNodes[g].appendChild(opt);
          }
          for (const g of order) modelSel.appendChild(groupNodes[g]);
        }
        // If the active model isn't in the list (e.g. a custom slug),
        // add it at the top so saving doesn't silently overwrite it.
        const present = Array.from(modelSel.querySelectorAll('option')).some(function (o) { return o.value === selected; });
        if (selected && !present) {
          const keep = document.createElement('option');
          keep.value = selected;
          keep.textContent = selected + ' (current)';
          keep.selected = true;
          modelSel.insertBefore(keep, modelSel.firstChild);
        }
      }
      // Decorate a curated slug with live pricing + context if the
      // openrouter catalogue fetch returned a matching entry.
      function decorate(curated, liveById) {
        const live = liveById[curated.id];
        let suffix = curated.note ? ' (' + curated.note + ')' : '';
        if (live) {
          const inPrice = live.pricing && live.pricing.prompt;
          const outPrice = live.pricing && live.pricing.completion;
          if (inPrice != null) suffix += ' \u00b7 ' + fmtPrice(inPrice) + ' in / ' + fmtPrice(outPrice) + ' out';
          if (live.context_length) suffix += ' \u00b7 ' + Math.round(live.context_length / 1000) + 'k ctx';
        }
        return { id: curated.id, label: curated.label + suffix, group: curated.group };
      }
      // What slug should stay selected after we rebuild the dropdown?
      // When provider hasn't changed (async decorate pass), preserve the
      // user's current pick so re-rendering mid-interaction doesn't wipe
      // their selection. When provider DID just change, fall back to the
      // session's ACTIVE_MODEL only if it's a valid slug for the new
      // provider; otherwise default to the first curated option so the
      // saved value matches what the human sees.
      function selectionFor(provider, providerChanged, items) {
        if (!providerChanged && modelSel.value) return modelSel.value;
        const ids = items.map(function (it) { return it.id; });
        if (ACTIVE_MODEL && ids.indexOf(ACTIVE_MODEL) !== -1) return ACTIVE_MODEL;
        // Pre-change active model might actually still be ACTIVE_MODEL if
        // it was already this provider's shape. Otherwise first option.
        return ids[0] || ACTIVE_MODEL;
      }
      // Monotonically increasing token. Each loadModelsFor call
      // increments it and captures its own local copy; any in-flight
      // fetch whose token no longer matches the current one bails out
      // before touching the DOM. Prevents the classic "user flips
      // provider mid-fetch and the stale response overwrites the new
      // dropdown" race.
      let loadToken = 0;
      async function loadModelsFor(provider, providerChanged) {
        const myToken = ++loadToken;
        if (provider !== 'openrouter') {
          const fallback = (FALLBACK[provider] || []).map(function (id) { return { id: id, label: id }; });
          setOptions(fallback, selectionFor(provider, providerChanged, fallback));
          modelHint.textContent = 'Suggestions for ' + provider + '. Custom slugs still work; edit config.json if the one you want is not listed.';
          return;
        }
        // Seed immediately with the curated list so the dropdown is
        // usable before the live fetch resolves (and stays usable if
        // the fetch fails). Live pricing + context chips land on top
        // as an enhancement once the catalogue is back.
        const curatedNoLive = CURATED_OPENROUTER.map(function (c) { return decorate(c, {}); });
        setOptions(curatedNoLive, selectionFor(provider, providerChanged, curatedNoLive));
        modelHint.textContent = 'Curated top ' + CURATED_OPENROUTER.length + ' on OpenRouter. Fetching live pricing\u2026';
        try {
          const res = await fetch('/openrouter-models', { cache: 'no-store' });
          if (myToken !== loadToken) return;
          if (!res.ok) throw new Error('http ' + res.status);
          const payload = await res.json();
          if (myToken !== loadToken) return;
          const liveById = {};
          for (const m of (payload.models || [])) liveById[m.id] = m;
          const items = CURATED_OPENROUTER.map(function (c) { return decorate(c, liveById); });
          // providerChanged=false here: this is the async decorate pass
          // for the SAME provider the user picked, so preserve whatever
          // they've selected since the seed render.
          setOptions(items, selectionFor('openrouter', false, items));
          const total = (payload.models || []).length;
          modelHint.textContent = 'Curated top ' + items.length + ' on OpenRouter (of ' + total + ' total). Custom slugs still work; edit config.json for anything else.';
        } catch (err) {
          if (myToken !== loadToken) return;
          modelHint.textContent = 'Curated top ' + CURATED_OPENROUTER.length + ' on OpenRouter. Live pricing unavailable (' + (err.message || 'offline') + ').';
        }
      }
      providerSel.addEventListener('change', function () { loadModelsFor(providerSel.value, true); });
      loadModelsFor(providerSel.value, true);
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        e.stopPropagation();
        const data = {};
        for (const el of form.elements) {
          if (!el.name) continue;
          if (el.type === 'checkbox') {
            // Only send checked boxes. Without this branch, el.value is
            // always '1' regardless of checked state, which would make
            // every checkbox look checked server-side.
            if (el.checked) data[el.name] = '1';
            continue;
          }
          const v = (el.value || '').trim();
          if (v) data[el.name] = v;
        }
        setStatus('saving\u2026');
        try {
          const res = await fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
          if (!res.ok) throw new Error('save failed');
          const body = await res.json().catch(function () { return {}; });
          let suffix = '';
          if (body && body.model) {
            const n = (body.appliedProfiles || []).length;
            suffix = ' model: ' + body.model + (n > 1 ? ' \u00b7 applied to ' + n + ' profiles' : '');
          }
          setStatus('\u2713 saved.' + suffix + ' You can close this tab and return to the terminal.', 'ok');
          setTimeout(function () { try { window.close(); } catch (e) {} }, 1800);
        } catch (err) {
          setStatus('save failed: ' + (err.message || 'unknown'), 'err');
        }
        return false;
      });
      skipBtn.addEventListener('click', async function () {
        try { await fetch('/skip', { method: 'POST' }); } catch (e) {}
        setStatus('skipped.');
        setTimeout(function () { try { window.close(); } catch (e) {} }, 800);
      });
    })();
  </script>
</body>
</html>`;
}

function providerLabel(p: Provider): string {
  switch (p) {
    case 'anthropic': return 'Anthropic';
    case 'openai': return 'OpenAI';
    case 'google': return 'Google';
    case 'openrouter': return 'OpenRouter (100s of models)';
    case 'ollama': return 'Ollama (local)';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// In-memory cache of the OpenRouter model catalogue. The upstream
// endpoint is public (no key required) but we still proxy through here
// so the browser page stays fully local-only and doesn't depend on
// CORS headers. 1-hour TTL is generous — new models land often but not
// by-the-minute, and the wizard is long-lived (one server per CLI
// lifetime), so the alternative of per-GET fetches would flap over the
// same data. Set TTL to 0 to disable the cache during debugging.
interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}
const OPENROUTER_CACHE_TTL_MS = 60 * 60 * 1000;
const openrouterCache: { fetchedAt: number; models: OpenRouterModel[] } = { fetchedAt: 0, models: [] };
let openrouterInflight: Promise<OpenRouterModel[]> | null = null;

async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  const now = Date.now();
  if (openrouterCache.models.length > 0 && now - openrouterCache.fetchedAt < OPENROUTER_CACHE_TTL_MS) {
    return openrouterCache.models;
  }
  if (openrouterInflight) return openrouterInflight;
  openrouterInflight = (async () => {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) throw new Error(`openrouter models http ${res.status}`);
      const payload = (await res.json()) as { data?: OpenRouterModel[] };
      const models = Array.isArray(payload.data) ? payload.data : [];
      openrouterCache.fetchedAt = Date.now();
      openrouterCache.models = models;
      return models;
    } finally {
      openrouterInflight = null;
    }
  })();
  return openrouterInflight;
}

// Walk the preferred ports in order; return the first that binds. Falls
// back to port 0 (OS-picked random) if every preferred port is taken, so
// two parallel CLI invocations on the same machine never deadlock each
// other. Returns the bound port so the caller can log the exact URL.
async function bindServer(server: Server): Promise<number> {
  for (const port of PREFERRED_WIZARD_PORTS) {
    const bound = await new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListen);
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
        else resolve(false);
      };
      const onListen = () => {
        server.off('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(port, '127.0.0.1');
    });
    if (bound) return port;
  }
  // All preferred ports busy; let the OS pick one.
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo | null;
  return addr?.port ?? 0;
}

// Module-level settings-server state. The server stays alive for the
// lifetime of the CLI process so a user can always navigate to
// http://127.0.0.1:4242/ to edit keys, not just on first boot. Previous
// behaviour (ephemeral server that closed on save/skip/timeout) meant
// typing the URL after first-run just returned ERR_CONNECTION_REFUSED,
// which defeated the point of documenting a stable bookmarkable URL.
const serverState: {
  server: Server | null;
  port: number;
  url: string;
  // Active profile name at wizard-boot time. Shown in the header copy
  // so the human knows which agent they're about to reconfigure (the
  // model they pick here writes to THIS profile's config.json, not the
  // default). Profile is a process-level setting — a single CLI
  // process ever runs as one profile — so capturing it once at server
  // start is correct. (Per-request currentProfileName() would work
  // inside withProfile scopes but the HTTP handler runs outside them.)
  profile: string;
  // One-shot listeners that resolve on the NEXT /save or /skip. Used by
  // the first-run waiter below so the CLI can block on "please paste a
  // key" until the user either does or skips.
  waiters: Array<(result: WizardResult) => void>;
} = { server: null, port: 0, url: '', profile: 'default', waiters: [] };

function handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  // Strip query string. If a GET hits / with ?anthropicApiKey=... in
  // the URL, that's the 0.10.0 bug (native form submit via GET leaking
  // keys into the URL bar). We serve the page anyway so the user sees
  // the form, but we never treat URL params as a save. Defense in
  // depth alongside the client-side fix.
  const urlPath = (req.url || '').split('?')[0];
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    // Re-read keys + config on every GET so the form reflects current
    // on-disk state (useful if the user edited values out-of-band
    // between page loads, or switched profiles via env var).
    const cfg = loadConfig();
    // Count distinct local profiles so the page can decide whether to
    // show the "apply to all" checkbox (1 profile = nothing to fan to).
    // The active profile is always counted even if listProfiles misses
    // it (fresh install where config.json hasn't been written yet).
    const profileSet = new Set<string>(listProfiles());
    profileSet.add(serverState.profile);
    const body = renderPage(loadSharedKeys(), cfg.provider, cfg.model, serverState.profile, profileSet.size);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }
  if (req.method === 'GET' && urlPath === '/openrouter-models') {
    // Serve the cached OpenRouter catalogue as JSON for the client-side
    // dropdown hydration. Proxying (instead of fetching directly from
    // the browser) keeps the page self-contained and makes caching
    // server-side where it's useful across tabs/reloads.
    void (async () => {
      try {
        const models = await fetchOpenRouterModels();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ models }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error).message, models: [] }));
      }
    })();
    return;
  }
  if (req.method === 'POST' && req.url === '/save') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString('utf8'); if (raw.length > 16384) req.destroy(); });
    req.on('end', () => {
      try {
        const obj = JSON.parse(raw || '{}') as Partial<SharedKeys> & { provider?: string; model?: string; applyAll?: string };
        const updates: Partial<SharedKeys> = {};
        if (obj.anthropicApiKey)  updates.anthropicApiKey  = String(obj.anthropicApiKey).trim();
        if (obj.openaiApiKey)     updates.openaiApiKey     = String(obj.openaiApiKey).trim();
        if (obj.googleApiKey)     updates.googleApiKey     = String(obj.googleApiKey).trim();
        if (obj.openrouterApiKey) updates.openrouterApiKey = String(obj.openrouterApiKey).trim();
        if (obj.ollamaBaseUrl) {
          const v = String(obj.ollamaBaseUrl).trim();
          try { new URL(v); updates.ollamaBaseUrl = v; } catch { /* ignore bad URL */ }
        }
        const mergedKeys = saveSharedKeys(updates);

        // Provider/model route to the active profile's config.json.
        // Normalize so that an openrouter-style dotted slug picked
        // while provider=anthropic gets rewritten for the direct API
        // (and vice versa) — same repair path loadConfig() already
        // does, just at write time so the on-disk file is clean.
        //
        // When applyAll is set, fan the provider+model write out across
        // every local profile. Common case: the human spawned 10 agents
        // on krawler.com, /sync created 10 profiles (each inheriting
        // provider=anthropic + model=claude-opus-4-7 from personal),
        // Opus hurts, they want everyone on Kimi K2 in one click. Keys
        // are ALWAYS shared (one shared-keys.json per machine), so the
        // checkbox only governs the per-profile provider/model fields.
        let mergedProvider: Provider | undefined;
        let mergedModel: string | undefined;
        let appliedProfiles: string[] = [];
        const wantsProvider = typeof obj.provider === 'string' && (PROVIDERS as readonly string[]).includes(obj.provider);
        const wantsModel = typeof obj.model === 'string' && obj.model.trim().length > 0;
        const wantsApplyAll = Boolean(obj.applyAll);
        if (wantsProvider || wantsModel) {
          const current = loadConfig();
          const nextProvider: Provider = wantsProvider ? (obj.provider as Provider) : current.provider;
          const nextModelRaw = wantsModel ? String(obj.model).trim() : current.model;
          const nextModel = normalizeModelForProvider(nextProvider, nextModelRaw);
          if (wantsApplyAll) {
            const profiles = listProfiles();
            // If this is a fresh install with only the default profile
            // on disk, listProfiles can return empty (no config.json
            // yet). Fall back to the active profile so the save still
            // lands somewhere observable. Always include the currently-
            // active profile so its config.json gets updated even if
            // the profile scan missed it (e.g. transient ENOENT).
            const seen = new Set<string>(profiles);
            seen.add(serverState.profile);
            for (const name of seen) {
              const saved = withProfile(name, () => saveConfig({ provider: nextProvider, model: nextModel })) as ReturnType<typeof saveConfig>;
              mergedProvider = saved.provider;
              mergedModel = saved.model;
              appliedProfiles.push(name);
            }
          } else {
            const saved = saveConfig({ provider: nextProvider, model: nextModel });
            mergedProvider = saved.provider;
            mergedModel = saved.model;
            appliedProfiles = [serverState.profile];
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, provider: mergedProvider, model: mergedModel, appliedProfiles }));
        const waiters = serverState.waiters.splice(0);
        for (const w of waiters) w({ saved: true, keys: mergedKeys, url: serverState.url });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/skip') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    const waiters = serverState.waiters.splice(0);
    for (const w of waiters) w({ saved: false, keys: loadSharedKeys(), url: serverState.url });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

// Ensure the always-on settings server is running. Safe to call many
// times — subsequent calls just return the cached state. Called from the
// REPL boot path so the URL is reachable for the whole session.
export async function ensureSettingsServer(): Promise<{ port: number; url: string }> {
  if (serverState.server) {
    return { port: serverState.port, url: serverState.url };
  }
  // Capture the profile the wizard is bound to. Imported here (not at
  // top level) to keep the dependency on profile-context localised —
  // the rest of this file doesn't need to know the current profile,
  // only handleRequest does, via serverState.
  const { currentProfileName } = await import('./profile-context.js');
  serverState.profile = currentProfileName();
  const server = createServer(handleRequest);
  // Silence 'error' event if the server hits trouble while already
  // listening (would otherwise crash the process). Binding errors are
  // caught inside bindServer's per-attempt promises.
  server.on('error', () => { /* swallow post-bind errors */ });
  const port = await bindServer(server);
  serverState.server = server;
  serverState.port = port;
  serverState.url = `http://127.0.0.1:${port}/`;
  // Clean shutdown on process exit so the port frees up for the next
  // run. Node clears listeners on exit anyway, but being explicit is
  // cheaper than debugging a "port already in use" on the next boot
  // when the shell's parent signalled odd.
  const shutdown = () => { try { server.close(); } catch { /* ignore */ } };
  process.once('exit', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { port, url: serverState.url };
}

// Open the running settings form in the browser. No-op if the server
// isn't running yet; caller should ensureSettingsServer() first.
export async function openSettingsBrowser(): Promise<{ url: string }> {
  const { url } = await ensureSettingsServer();
  void open(url).catch(() => { /* best-effort */ });
  return { url };
}

// First-run gate. If no provider key is set, this opens the browser and
// blocks until the user clicks Save or Skip, or until the 30-min timeout
// fires. The underlying server stays up after resolution (unlike the
// pre-0.12.3 behaviour that closed it), so `/keys` and manual URL
// navigation keep working for the whole session.
export function startKeyWizard(): Promise<WizardResult> {
  return new Promise<WizardResult>((resolve) => {
    let settled = false;
    const settle = (result: WizardResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    void (async () => {
      const existing = loadSharedKeys();
      const { url } = await ensureSettingsServer();
      // eslint-disable-next-line no-console
      console.log(`  \u{1F511} provider keys needed. opening ${url}`);
      // eslint-disable-next-line no-console
      console.log(`     if it didn't open, paste that URL in your browser.`);
      void open(url).catch(() => { /* best-effort */ });
      serverState.waiters.push((result) => settle(result));
      // 30-minute safety. Resolve with an empty result so the REPL can
      // continue rather than blocking forever if the user walks away.
      // The server itself stays alive regardless.
      setTimeout(() => settle({ saved: false, keys: existing, url }), 30 * 60 * 1000);
    })();
  });
}

// Whether any provider slot is populated. Used at boot to decide if
// we should run the wizard before the existing waiting-for-creds
// loop kicks in.
export function hasAnyProviderKey(keys: SharedKeys): boolean {
  return Boolean(keys.anthropicApiKey || keys.openaiApiKey || keys.googleApiKey || keys.openrouterApiKey);
}
