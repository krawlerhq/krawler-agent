// Credential-probe helpers used by PATCH /api/config to validate keys the
// moment the human pastes them on the settings page, instead of letting a
// bad key sit in config.json until the next heartbeat silently fails.
//
// Every probe is a cheap, read-only call against the provider's cheapest
// auth-required endpoint (usually GET /models), with a 5s timeout so a
// flaky network doesn't hang the settings save. Probes never throw; they
// always resolve to a ValidationResult.

import type { Provider } from './config.js';

const TIMEOUT_MS = 5_000;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

async function probe(url: string, init: RequestInit = {}): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function classify(r: Response, host: string): ValidationResult {
  if (r.status === 401 || r.status === 403) {
    return { ok: false, reason: `${host} rejected the key (HTTP ${r.status}). Check the key was copied correctly and has permission for this model.` };
  }
  if (!r.ok) {
    return { ok: false, reason: `${host} returned HTTP ${r.status}.` };
  }
  return { ok: true };
}

function networkFailure(e: unknown): ValidationResult {
  if ((e as Error)?.name === 'AbortError') {
    return { ok: false, reason: 'validation timed out after 5s. Check your network and retry.' };
  }
  return { ok: false, reason: `network error: ${(e as Error).message}` };
}

// Probe the model-provider API with the credential the human just pasted.
// For ollama the "credential" argument is actually a base URL; the rest
// are secret keys. Empty credentials short-circuit to ok:false so callers
// don't send empty keys down to the provider.
export async function validateProviderCredential(
  provider: Provider,
  credential: string,
): Promise<ValidationResult> {
  if (!credential.trim()) return { ok: false, reason: 'empty credential' };
  try {
    switch (provider) {
      case 'anthropic': {
        // GET /v1/models is free and returns 200 with a model list on a
        // good key, 401 on a bad one.
        const r = await probe('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': credential,
            'anthropic-version': '2023-06-01',
          },
        });
        return classify(r, 'api.anthropic.com');
      }
      case 'openai': {
        const r = await probe('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${credential}` },
        });
        return classify(r, 'api.openai.com');
      }
      case 'google': {
        // Gemini takes the key as a query param, not a header. Bad keys
        // return 400 here (not 401), so we special-case that status.
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(credential)}`;
        const r = await probe(url);
        if (r.status === 400) {
          return { ok: false, reason: 'generativelanguage.googleapis.com rejected the key (HTTP 400). Check the key at aistudio.google.com/apikey.' };
        }
        return classify(r, 'generativelanguage.googleapis.com');
      }
      case 'openrouter': {
        // /api/v1/auth/key returns current usage + limit on a good key,
        // 401 on a bad one. Cheaper than /v1/models since it's a tiny
        // JSON object.
        const r = await probe('https://openrouter.ai/api/v1/auth/key', {
          headers: { Authorization: `Bearer ${credential}` },
        });
        return classify(r, 'openrouter.ai');
      }
      case 'ollama': {
        // Credential is the base URL. Reachable + /api/tags 200 is enough.
        const base = credential.replace(/\/+$/, '');
        try {
          new URL(base);
        } catch {
          return { ok: false, reason: `not a valid URL: ${base}` };
        }
        const r = await probe(`${base}/api/tags`);
        if (!r.ok) return { ok: false, reason: `ollama at ${base} returned HTTP ${r.status}` };
        return { ok: true };
      }
    }
  } catch (e) {
    return networkFailure(e);
  }
  return { ok: false, reason: `unknown provider: ${provider}` };
}

// Probe the Krawler platform with the API key the human just pasted.
// Hits GET /me which returns 200 with the agent record on a good key,
// 401 on a bad one. baseUrl is the configured krawlerBaseUrl (ends in
// /api on the default setup).
export async function validateKrawlerKey(baseUrl: string, key: string): Promise<ValidationResult> {
  if (!key.trim()) return { ok: false, reason: 'empty key' };
  try {
    const base = baseUrl.replace(/\/+$/, '');
    const r = await probe(`${base}/me`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    return classify(r, 'krawler.com');
  } catch (e) {
    return networkFailure(e);
  }
}
