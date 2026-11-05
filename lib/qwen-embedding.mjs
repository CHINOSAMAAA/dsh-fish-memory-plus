// DashScope HTTP 协议独立实现；仅支持 Qwen text-embedding-v3/v4。
import { createHash } from 'node:crypto'
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const KEY_REF = 'FISH_MEMORY_QWEN_API_KEY'
export const DEFAULT_EMBEDDING = { enabled: false, endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding', model: 'text-embedding-v4', dimensions: 1024, minSimilarity: 0.75, topK: 12, timeoutMs: 1800, revision: 0 }
export function embeddingConfig(raw = {}) {
  const c = { ...DEFAULT_EMBEDDING, ...raw }
  const url = new URL(c.endpoint)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Embedding 地址须为 HTTPS（本机测试可用 HTTP），不能含凭据或查询参数')
  if (!['text-embedding-v3', 'text-embedding-v4'].includes(c.model)) throw new Error('首版仅支持 text-embedding-v3/v4')
  if (![64, 128, 256, 512, 768, 1024, ...(c.model === 'text-embedding-v4' ? [1536, 2048] : [])].includes(c.dimensions)) throw new Error('Qwen 向量维度无效')
  if (!Number.isFinite(c.minSimilarity) || c.minSimilarity < 0.5 || c.minSimilarity > 0.99 || !Number.isInteger(c.topK) || c.topK < 1 || c.topK > 50 || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 10000) throw new Error('Embedding 检索参数无效')
  return { enabled: c.enabled === true, endpoint: url.href, model: c.model, dimensions: c.dimensions, minSimilarity: c.minSimilarity, topK: c.topK, timeoutMs: c.timeoutMs, revision: Number(c.revision) || 0 }
}
export const configId = c => hash([c.endpoint, c.model, c.dimensions, c.revision])
export function normalizeVector(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('invalid_vector')
  const norm = Math.hypot(...vector)
  if (!Number.isFinite(norm) || norm === 0) throw new Error('invalid_vector')
  return vector.map(x => x / norm)
}
export async function embed(c, texts, type, getKey, signal) {
  if (!texts.length || texts.length > 10 || texts.some(t => typeof t !== 'string' || !t.trim() || Buffer.byteLength(t) > 8192)) throw new Error('input_limit')
  const timeout = AbortSignal.timeout(type === 'document' ? Math.max(10000, c.timeoutMs) : c.timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let abort
  const cancelled = new Promise((_, reject) => { abort = () => reject(new Error('cancelled')); combined.addEventListener('abort', abort, { once: true }); if (combined.aborted) abort() })
  try {
    return await Promise.race([cancelled, (async () => {
      const key = await getKey()
      combined.throwIfAborted()
      if (!key) throw new Error('missing_key')
      // 对话查询不重试；后台补齐由下一批/下次操作续跑，避免延长本轮等待与重复计费。
      const response = await fetch(c.endpoint, { method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: c.model, input: { texts }, parameters: { dimension: c.dimensions, text_type: type, output_type: 'dense' } }) })
      if (!response.ok) throw new Error('http_' + response.status)
      const body = await response.json()
      const rows = body?.output?.embeddings
      if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error('invalid_count')
      const vectors = new Array(texts.length), seen = new Set()
      for (const row of rows) {
        const i = row.text_index ?? row.index
        if (!Number.isInteger(i) || i < 0 || i >= texts.length || seen.has(i) || (row.text_index !== undefined && row.index !== undefined && row.text_index !== row.index)) throw new Error('invalid_index')
        seen.add(i); vectors[i] = normalizeVector(row.embedding, c.dimensions)
      }
      return vectors
    })()])
  } catch (error) {
    if (combined.aborted) throw new Error(signal?.aborted ? 'cancelled' : 'timeout')
    // 不转交服务端错误正文或 fetch 错误，它们可能包含密钥、输入文本和地址。
    if (/^(http_\d+|invalid_\w+|missing_key)$/.test(error.message)) throw error
    throw new Error('network_or_response')
  } finally { combined.removeEventListener('abort', abort) }
}
