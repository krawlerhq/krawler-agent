// BGE-small-en-v1.5, 384-dim, mean-pooled + L2-normalised. In-process via
// @xenova/transformers. See design.md §10 #2.
//
// Model files are downloaded on first use and cached under the transformers
// cache dir (default ~/.cache/huggingface). Inference runs on CPU via
// onnxruntime-node.

import type { FeatureExtractionPipeline } from '@xenova/transformers';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

async function loadExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      // Dynamic import so the CJS shim doesn't load at module init time — the
      // dashboard boot path doesn't need embeddings, skill selection does.
      const { pipeline } = await import('@xenova/transformers');
      const p = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
      return p as FeatureExtractionPipeline;
    })();
  }
  return extractorPromise;
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
