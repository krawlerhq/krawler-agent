// Local one-page HTML wizard for first-time provider-key paste.
//
// Why this exists: provider API keys (Anthropic/OpenAI/Google/OpenRouter,
// plus the Ollama base URL) live in ~/.config/krawler-agent/shared-keys.json.
// Storing them locally is the right call — krawler.com never sees them,
// which keeps the privacy promise intact. But hand-editing JSON to paste
// a fresh sk-ant-... every time is not a first-run UX we want.
//
// So: on first run, if shared-keys.json has no populated key, the CLI
// spawns a tiny HTTP server on 127.0.0.1:<random-port>, opens the
// browser to it, and serves one self-contained HTML page with a key
// form. User pastes, clicks Save, we write shared-keys.json and shut
// the server down. Auto-timeout at 30 min so a wandered-off user
// doesn't leave a listening port open forever.
//
// Scope is DELIBERATELY tight. This is NOT the 0.6.0 settings
// dashboard coming back. It's only for provider keys — runtime
// config (provider choice, cadence, dry-run, model) stays on
// krawler.com/agent/<handle>/settings modal.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import open from 'open';

import { loadSharedKeys, saveSharedKeys } from './config.js';
import type { SharedKeys } from './config.js';

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

// Render the key-form HTML. All styles inline so a user doesn't need
// krawler.com reachable to see a polished page. Existing keys render
// as placeholders (masked) so the user knows which slots are already
// set — they can leave those blank to keep them.
function renderPage(existing: SharedKeys): string {
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
    body { font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 40px 16px; }
    .card { max-width: 560px; margin: 0 auto; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.04); }
    h1 { font-size: 1.35rem; margin: 0 0 8px; font-weight: 700; }
    .sub { color: var(--text-2); font-size: 0.9rem; margin: 0 0 24px; line-height: 1.5; }
    .row { margin-bottom: 16px; }
    label { display: block; font-weight: 600; font-size: 0.85rem; margin-bottom: 4px; color: var(--text-2); }
    input[type=password], input[type=text], input[type=url] { width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 0.92rem; background: var(--surface); font-family: var(--mono); }
    input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
    .hint { font-size: 0.75rem; color: var(--text-3); margin-top: 4px; }
    .hint code { background: var(--bg); padding: 1px 5px; border-radius: 4px; font-family: var(--mono); }
    .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 24px; }
    button { font: inherit; font-size: 0.9rem; font-weight: 600; padding: 9px 18px; border-radius: 9999px; border: none; cursor: pointer; }
    .primary { background: var(--brand); color: #fff; }
    .primary:hover { background: var(--brand-dark); }
    .secondary { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
    .status { font-size: 0.82rem; color: var(--text-3); margin-top: 16px; min-height: 1em; text-align: center; }
    .status.err { color: #b91c1c; }
    .status.ok { color: #166534; }
    footer { text-align: center; font-size: 0.75rem; color: var(--text-3); margin-top: 16px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Krawler \u2014 provider keys</h1>
    <p class="sub">Paste at least one key so your local agent can call a model. Keys never leave this machine \u2014 they write to <code style="font-family:var(--mono);">~/.config/krawler-agent/shared-keys.json</code>.</p>
    <!-- method=post is belt-and-suspenders: even if the JS handler
         somehow no-ops, native submission won't dump the keys into a
         GET query string (which is what happened in 0.10.0 because the
         JS function was named 'submit', colliding with HTMLFormElement.submit). -->
    <form id="keyForm" method="post" action="/save" autocomplete="off">
      ${fieldHtml}
      <div class="row">
        <label for="ollamaBaseUrl">Ollama base URL</label>
        <input type="url" id="ollamaBaseUrl" name="ollamaBaseUrl" placeholder="${existing.ollamaBaseUrl || 'http://localhost:11434'}" value="${existing.ollamaBaseUrl && existing.ollamaBaseUrl !== 'http://localhost:11434' ? existing.ollamaBaseUrl : ''}" />
        <div class="hint">default: <code>http://localhost:11434</code>. Only change if you run Ollama elsewhere.</div>
      </div>
      <div class="actions">
        <button type="button" class="secondary" id="skipBtn">Skip</button>
        <button type="submit" class="primary" id="saveBtn">Save keys</button>
      </div>
    </form>
    <div class="status" id="status"></div>
    <footer>This page is served by your local <code>krawler</code> process. Come back to <code>http://127.0.0.1:4242/</code> any time (or type <code>/keys</code> in the chat) to add or rotate keys.</footer>
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
      function setStatus(msg, kind) {
        status.className = 'status' + (kind ? ' ' + kind : '');
        status.textContent = msg;
      }
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        e.stopPropagation();
        const data = {};
        for (const el of form.elements) {
          if (!el.name) continue;
          const v = (el.value || '').trim();
          if (v) data[el.name] = v;
        }
        setStatus('saving\u2026');
        try {
          const res = await fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
          if (!res.ok) throw new Error('save failed');
          setStatus('\u2713 saved. You can close this tab and return to the terminal.', 'ok');
          setTimeout(function () { try { window.close(); } catch (e) {} }, 1200);
        } catch (err) {
          setStatus('save failed: ' + (err.message || 'unknown'), 'err');
        }
        return false;
      });
      skipBtn.addEventListener('click', async function () {
        try { await fetch('/skip', { method: 'POST' }); } catch (e) {}
        setStatus('skipped. The CLI will wait for keys in shared-keys.json.');
        setTimeout(function () { try { window.close(); } catch (e) {} }, 800);
      });
    })();
  </script>
</body>
</html>`;
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
  // One-shot listeners that resolve on the NEXT /save or /skip. Used by
  // the first-run waiter below so the CLI can block on "please paste a
  // key" until the user either does or skips.
  waiters: Array<(result: WizardResult) => void>;
} = { server: null, port: 0, url: '', waiters: [] };

function handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  // Strip query string. If a GET hits / with ?anthropicApiKey=... in
  // the URL, that's the 0.10.0 bug (native form submit via GET leaking
  // keys into the URL bar). We serve the page anyway so the user sees
  // the form, but we never treat URL params as a save. Defense in
  // depth alongside the client-side fix.
  const urlPath = (req.url || '').split('?')[0];
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    // Re-read keys on every GET so the masked placeholders reflect the
    // current on-disk state (useful if the user edited keys out-of-band
    // between page loads).
    const body = renderPage(loadSharedKeys());
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }
  if (req.method === 'POST' && req.url === '/save') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString('utf8'); if (raw.length > 8192) req.destroy(); });
    req.on('end', () => {
      try {
        const obj = JSON.parse(raw || '{}') as Partial<SharedKeys>;
        const updates: Partial<SharedKeys> = {};
        if (obj.anthropicApiKey)  updates.anthropicApiKey  = String(obj.anthropicApiKey).trim();
        if (obj.openaiApiKey)     updates.openaiApiKey     = String(obj.openaiApiKey).trim();
        if (obj.googleApiKey)     updates.googleApiKey     = String(obj.googleApiKey).trim();
        if (obj.openrouterApiKey) updates.openrouterApiKey = String(obj.openrouterApiKey).trim();
        if (obj.ollamaBaseUrl) {
          const v = String(obj.ollamaBaseUrl).trim();
          try { new URL(v); updates.ollamaBaseUrl = v; } catch { /* ignore bad URL */ }
        }
        const merged = saveSharedKeys(updates);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        const waiters = serverState.waiters.splice(0);
        for (const w of waiters) w({ saved: true, keys: merged, url: serverState.url });
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
