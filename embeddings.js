'use strict';

// Local embeddings using all-MiniLM-L6-v2 (384 dimensions)
// Runs entirely on CPU, no API key needed, ~80MB model (downloaded once)
// Replaces OpenAI text-embedding-3-small for semantic memory search

let pipeline = null;
let extractor = null;
let loading = null; // prevents multiple concurrent loads

async function loadModel() {
  if (extractor) return extractor;
  if (loading) return loading;

  loading = (async () => {
    const { pipeline: createPipeline } = await import('@xenova/transformers');
    console.log('[EMBEDDINGS] Loading local model (first run downloads ~80MB)...');
    extractor = await createPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true // smaller + faster, negligible quality loss
    });
    console.log('[EMBEDDINGS] Local model ready (all-MiniLM-L6-v2)');
    loading = null;
    return extractor;
  })();

  return loading;
}

/**
 * Generate embedding vector for text (384 dimensions)
 * @param {string} text - Input text (truncated to ~512 chars internally)
 * @returns {number[]} Embedding vector
 */
async function getEmbedding(text) {
  if (!text || text.length < 2) return null;
  const model = await loadModel();
  const output = await model(text.slice(0, 512), { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// Pre-warm the model (call on startup, non-blocking)
function warmup() {
  loadModel().catch(e => console.warn('[EMBEDDINGS] Warmup failed:', e.message));
}

module.exports = { getEmbedding, warmup };
