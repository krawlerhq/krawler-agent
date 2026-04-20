// BGE-small-en-v1.5, 384-dim, mean-pooled + L2-normalised. In-process via
// @xenova/transformers. See design.md §10 #2.
//
// Model files are downloaded on first use and cached under the transformers
// cache dir (default ~/.cache/huggingface). Inference runs on CPU via
// onnxruntime-node.
//
// `@xenova/transformers` is declared as an OPTIONAL peer dependency in
// package.json: the core agent (chat REPL + heartbeat + link flow) doesn't
// need it, so a default `npm i @krawlerhq/agent` doesn't pull in
// transformers (or its transitive sharp / onnx / protobuf chain, which
// brings deprecation warnings and several CVEs). The v1.0 gateway's
// playbook-selection path is the only caller of embed() and refuses to
// activate without the peer installed. Users who want the gateway run
// `npm i @xenova/transformers` alongside the agent.

let extractorPromise: Promise<unknown> | null = null;

async function loadExtractor(): Promise<(text: string, opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      let mod: typeof import('@xenova/transformers');
      try {
        mod = await import('@xenova/transformers');
      } catch (e) {
        throw new Error(
          '@xenova/transformers is not installed. Playbook-selection (the v1.0 gateway path) ' +
          'is an optional feature; install it alongside @krawlerhq/agent with ' +
          '`npm i @xenova/transformers` to enable embedding-based skill selection. ' +
          `Underlying error: ${(e as Error).message}`,
        );
      }
      const p = await mod.pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
      return p;
    })();
  }
  // Cast back to the invocable structural type. The real pipeline type
  // from transformers is compatible; we don't re-import the type so the
  // compiled dist/ doesn't leak an import reference.
  return extractorPromise as Promise<(text: string, opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>>;
}

export async function embed(text: string): Promise<Float32Array> {
  const extractor = await loadExtractor();
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  // out.data is BGE-small's output float tensor; mean-pooled + L2-normalized.
  // The library's type union includes BigInt arrays for other pipelines, so
  // we copy through Array.from before reaching Float32Array.
  return toFloat32(out.data);
}

export async function embedMany(texts: string[]): Promise<Float32Array[]> {
  const extractor = await loadExtractor();
  const results: Float32Array[] = [];
  for (const t of texts) {
    const out = await extractor(t, { pooling: 'mean', normalize: true });
    results.push(toFloat32(out.data));
  }
  return results;
}

function toFloat32(data: unknown): Float32Array {
  if (data instanceof Float32Array) return new Float32Array(data);
  const src = data as ArrayLike<number>;
  const arr = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) arr[i] = Number(src[i]);
  return arr;
}

// Cosine similarity on unit-norm vectors = dot product.
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    s += av * bv;
  }
  return s;
}

export const EMBEDDING_DIM = 384;
