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

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import open from 'open';

import { loadSharedKeys, saveSharedKeys } from './config.js';
import type { SharedKeys } from './config.js';

export interface WizardResult {
  saved: boolean;
  keys: SharedKeys;
}

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
    <form id="keyForm" onsubmit="return submit(event);">
      ${fieldHtml}
      <div class="row">
        <label for="ollamaBaseUrl">Ollama base URL</label>
        <input type="url" id="ollamaBaseUrl" name="ollamaBaseUrl" placeholder="${existing.ollamaBaseUrl || 'http://localhost:11434'}" value="${existing.ollamaBaseUrl && existing.ollamaBaseUrl !== 'http://localhost:11434' ? existing.ollamaBaseUrl : ''}" />
        <div class="hint">default: <code>http://localhost:11434</code>. Only change if you run Ollama elsewhere.</div>
      </div>
      <div class="actions">
        <button type="button" class="secondary" onclick="skip();">Skip</button>
        <button type="submit" class="primary">Save keys</button>
      </div>
    </form>
    <div class="status" id="status"></div>
    <footer>You'll see this screen once. To edit keys later, hand-edit the JSON or re-run <code>krawler</code> with an empty shared-keys.json.</footer>
  </div>
  <script>
    async function submit(e) {
      e.preventDefault();
      const form = document.getElementById('keyForm');
      const data = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        const v = (el.value || '').trim();
        if (v) data[el.name] = v;
      }
      const status = document.getElementById('status');
      status.className = 'status';
      status.textContent = 'saving\u2026';
      try {
        const res = await fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (!res.ok) throw new Error('save failed');
        status.className = 'status ok';
        status.textContent = '\u2713 saved. You can close this tab and return to the terminal.';
        setTimeout(() => { try { window.close(); } catch (e) {} }, 1200);
      } catch (err) {
        status.className = 'status err';
        status.textContent = 'save failed: ' + (err.message || 'unknown');
      }
    }
    async function skip() {
      try { await fetch('/skip', { method: 'POST' }); } catch (e) {}
      const status = document.getElementById('status');
      status.className = 'status';
      status.textContent = 'skipped. The CLI will wait for keys in shared-keys.json.';
      setTimeout(() => { try { window.close(); } catch (e) {} }, 800);
    }
  </script>
</body>
</html>`;
}

// Start the ephemeral key-wizard server, open the browser, and
// return a promise that resolves when the user clicks Save or Skip
// (or after a 30-min idle timeout).
export function startKeyWizard(): Promise<WizardResult> {
  return new Promise<WizardResult>((resolve) => {
    const existing = loadSharedKeys();
    let settled = false;
    const server = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const body = renderPage(existing);
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
            finish({ saved: true, keys: merged });
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
        finish({ saved: false, keys: existing });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    function finish(result: WizardResult): void {
      if (settled) return;
      settled = true;
      // Delay close so the client can read the final response.
      setTimeout(() => { try { server.close(); } catch { /* ignore */ } }, 400);
      resolve(result);
    }
    // Bind to 127.0.0.1:0 so the OS picks a free port. Avoids
    // collisions with the 0.5.x dashboard port (8717) still running
    // on some installs, and any other local service.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) { finish({ saved: false, keys: existing }); return; }
      const url = `http://127.0.0.1:${addr.port}/`;
      // eslint-disable-next-line no-console
      console.log(`  \u{1F511} provider keys needed. opening ${url}`);
      void open(url).catch(() => { /* best-effort */ });
    });
    // 30-minute safety timeout — close the port even if the user
    // wandered away, so we don't leak a listener.
    setTimeout(() => finish({ saved: false, keys: existing }), 30 * 60 * 1000);
  });
}

// Whether any provider slot is populated. Used at boot to decide if
// we should run the wizard before the existing waiting-for-creds
// loop kicks in.
export function hasAnyProviderKey(keys: SharedKeys): boolean {
  return Boolean(keys.anthropicApiKey || keys.openaiApiKey || keys.googleApiKey || keys.openrouterApiKey);
}
