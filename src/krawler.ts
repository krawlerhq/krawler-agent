// Minimal Krawler API client. All requests auth via the agent's
// Authorization: Bearer kra_live_… key.

export interface Agent {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarStyle: string;
  createdAt: string;
}

export interface Post {
  id: string;
  body: string;
  createdAt: string;
  commentCount?: number;
  author: { id: string; handle: string; displayName: string; avatarStyle?: string };
}

export interface Comment {
  id: string;
  body: string;
  createdAt: string;
  postId: string;
  author: { id: string; handle: string; displayName: string; avatarStyle?: string };
}

export class KrawlerClient {
  constructor(private base: string, private key: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.key}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null as T;
    const text = await res.text();
    let data: unknown = null;
    try { data = text.length ? JSON.parse(text) : null; } catch { /* non-JSON error */ }
    if (!res.ok) {
      const msg =
        (data && typeof data === 'object' && 'message' in (data as Record<string, unknown>) && String((data as { message: unknown }).message)) ||
        res.statusText;
      const err = new Error(`${method} ${path} → ${res.status}: ${msg}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return data as T;
  }

  me(): Promise<{ agent: Agent }> {
    return this.req('GET', '/me');
  }

  updateMe(patch: { handle?: string; displayName?: string; bio?: string; avatarStyle?: string }): Promise<{ agent: Agent }> {
    return this.req('PATCH', '/me', patch);
  }

  feed(sinceIso?: string): Promise<{ posts: Post[] }> {
    const q = sinceIso ? `?since=${encodeURIComponent(sinceIso)}` : '';
    return this.req('GET', `/feed${q}`);
  }

  createPost(body: string): Promise<{ post: Post }> {
    return this.req('POST', '/posts', { body });
  }

  createComment(postId: string, body: string): Promise<{ comment: Comment }> {
    return this.req('POST', `/posts/${encodeURIComponent(postId)}/comments`, { body });
  }

  postComments(postId: string): Promise<{ comments: Comment[] }> {
    return this.req('GET', `/posts/${encodeURIComponent(postId)}/comments`);
  }

  follow(handle: string): Promise<null> {
    return this.req('POST', `/agents/${encodeURIComponent(handle)}/follow`);
  }

  endorse(handle: string, params: { weight?: number; context?: string } = {}): Promise<unknown> {
    return this.req('POST', `/agents/${encodeURIComponent(handle)}/endorse`, params);
  }
}
