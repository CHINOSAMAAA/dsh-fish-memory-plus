import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from './atomic-file.mjs'
import { embeddingConfig, configId, hash, embed, normalizeVector } from './qwen-embedding.mjs'
export const activeMemory = m => m && !m.refinedSkip && !m.已被取代
export function createSemanticIndex({ home, config, load, storeId, input, getKey }) {
  const dir = join(home, 'fish-memory-vectors'), pending = new Map(), queries = new Map(), results = new Map()
  const state = { running: false, completed: 0, error: null }
  let generation = 0
  let controller = new AbortController()
  const current = () => embeddingConfig(config() || {})
  const path = (id, c) => join(dir, configId(c) + '-' + hash(id) + '.json')
  const read = (id, c, epoch) => {
    try {
      const cache = JSON.parse(readFileSync(path(id, c), 'utf8'))
      if (cache.storeId === id && cache.config === configId(c) && cache.epoch === epoch && cache.entries && typeof cache.entries === 'object' && !Array.isArray(cache.entries)) return cache
    } catch {}
    return { storeId: id, config: configId(c), epoch, entries: {} }
  }
  function valid(record, memory, c) {
    if (record?.hash !== hash(memory.text)) return false
    try { normalizeVector(record.vector, c.dimensions); return true } catch { return false }
  }
  async function fill(sid, limit = 10, signal, preferredIds = []) {
    const c = current()
    if (!c.enabled) return { completed: 0, missing: 0, disabled: true }
    const id = storeId(sid), data = load(sid), epoch = data.purgeEpoch || '', cache = read(id, c, epoch)
    const candidates = data.memories.filter(activeMemory)
    const missing = candidates.filter(m => !valid(cache.entries[m.id], m, c))
    const batch = missing.filter(m => (!preferredIds.length || preferredIds.includes(m.id)) && Buffer.byteLength(m.text) <= 8192).slice(0, Math.min(10, limit))
    if (!batch.length) return { completed: 0, missing: missing.length, oversized: missing.filter(m => Buffer.byteLength(m.text) > 8192).length }
    const captured = input(sid), token = generation
    const jobKey = hash([token, id, configId(c), epoch, captured.scope?.stamp, batch.map(m => [m.id, hash(m.text)])])
    if (pending.has(jobKey)) return pending.get(jobKey)
    const work = (async () => {
      const vectors = await embed(c, batch.map(m => m.text), 'document', getKey, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
      const freshInput = input(sid), fresh = load(sid), next = current()
      if (token !== generation || !next.enabled || configId(next) !== configId(c) || storeId(sid) !== id || (fresh.purgeEpoch || '') !== epoch || freshInput.scope?.stamp !== captured.scope?.stamp) return { completed: 0, missing: missing.length, discarded: true }
      const live = new Map(fresh.memories.filter(activeMemory).map(m => [m.id, m]))
      const updated = read(id, c, epoch)
      for (const key of Object.keys(updated.entries)) if (!live.has(key) || !valid(updated.entries[key], live.get(key), c)) delete updated.entries[key]
      let completed = 0
      batch.forEach((m, i) => {
        if (live.has(m.id) && hash(live.get(m.id).text) === hash(m.text)) { updated.entries[m.id] = { hash: hash(m.text), vector: vectors[i] }; completed++ }
      })
      mkdirSync(dir, { recursive: true })
      writeFileAtomicSync(path(id, c), JSON.stringify(updated))
      results.clear()
      return { completed, missing: fresh.memories.filter(activeMemory).filter(m => !valid(updated.entries[m.id], m, c)).length }
    })().finally(() => pending.delete(jobKey))
    pending.set(jobKey, work)
    return work
  }
  function snapshot(sid, session) {
    const c = current(), source = input(sid, session), version = []
    const ids = source.scope?.readIds || [storeId(sid)]
    const memories = []
    for (const id of ids) {
      const data = load(id), cache = read(id, c, data.purgeEpoch || '')
      for (const m of data.memories.filter(activeMemory)) {
        const record = cache.entries[m.id]
        const identity = source.scope ? id + '/' + m.id : m.id
        const vector = valid(record, m, c) ? normalizeVector(record.vector, c.dimensions) : null
        memories.push({ id: identity, vector })
        version.push([id, data.purgeEpoch, m.id, hash(m.text), vector])
      }
    }
    return { c, queryScope: hash([sid, ids, source.scope?.owner, configId(c)]), key: hash([sid, source.scope?.stamp, source.scope?.readIds, source.scope?.owner, configId(c), c.minSimilarity, c.topK, version]), memories }
  }
  async function prepare(sid, query, session, signal) {
    const start = Date.now(), snap = snapshot(sid, session), key = hash([snap.key, query])
    if (!snap.c.enabled) return null
    if (results.has(key)) return results.get(key)
    const work = (async () => {
      let scores = new Map(), similarities = new Map(), fallback = null
      try {
        if (!snap.memories.some(m => m.vector)) throw new Error('missing_vectors')
        const qKey = hash([snap.queryScope, query]) // 查询向量不依赖正文；候选结果仍按完整数据版本失效
        let entry = queries.get(qKey)
        if (!entry || Date.now() - entry.at > 30000) {
          entry = { at: Date.now(), promise: embed(snap.c, [query], 'query', getKey, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal) }
          const captured = entry
          entry.promise.catch(() => { if (queries.get(qKey) === captured) queries.delete(qKey) })
          if (queries.size >= 100) queries.clear()
          queries.set(qKey, entry)
        }
        const [vector] = await entry.promise
        const ranked = snap.memories.filter(m => m.vector).map(m => [m.id, Math.max(-1, Math.min(1, m.vector.reduce((sum, x, i) => sum + x * vector[i], 0))) ]).sort((a, b) => b[1] - a[1])
        similarities = new Map(ranked)
        scores = new Map(ranked.filter(([, score]) => score >= snap.c.minSimilarity).slice(0, snap.c.topK))
      } catch (e) { fallback = /^(http_\d+|invalid_\w+|network_or_response|missing_key|missing_vectors|timeout|cancelled|input_limit)$/.test(e.message) ? e.message : 'unavailable' }
      const fresh = snapshot(sid, session)
      if (fresh.key !== snap.key || !fresh.c.enabled) return null
      return { scores, similarities, missingIds: new Set(snap.memories.filter(m => !m.vector).map(m => m.id)), minSimilarity: snap.c.minSimilarity, missing: snap.memories.filter(m => !m.vector).length, fallback, latencyMs: Date.now() - start, key }
    })()
    // 缓存 Promise 同时合并重复组装；失败结果只在短窗口内复用，不形成永久熔断。
    if (results.size >= 100) results.clear()
    results.set(key, work)
    setTimeout(() => { if (results.get(key) === work) results.delete(key) }, 1500).unref?.()
    return work
  }
  function reset() { generation++; controller.abort(); controller = new AbortController(); queries.clear(); results.clear() }
  return { fill, prepare, reset, state,
    async enqueue(sid, ids) {
      const token = generation
      try { for (let i = 0; i < ids.length && token === generation; i += 10) await fill(sid, 10, undefined, ids.slice(i, i + 10)) }
      catch (e) { state.error = /^(http_\d+|invalid_\w+|network_or_response|missing_key|timeout|cancelled|input_limit)$/.test(e.message) ? e.message : 'unavailable' }
    },
    rebuild(sid) {
      reset()
      const c = current(), id = storeId(sid), data = load(sid)
      mkdirSync(dir, { recursive: true })
      writeFileAtomicSync(path(id, c), JSON.stringify({ storeId: id, config: configId(c), epoch: data.purgeEpoch || '', entries: {} }))
    },
    status(sid) {
      const snap = snapshot(sid)
      return { ...state, total: snap.memories.length, indexed: snap.memories.filter(m => m.vector).length, missing: snap.memories.filter(m => !m.vector).length }
    },
    async run(sids) {
      if (state.running) return
      reset(); const token = generation; state.running = true; state.completed = 0; state.error = null
      try {
        for (const sid of sids) {
          while (token === generation && current().enabled) {
            const result = await fill(sid)
            state.completed += result.completed
            if (!result.completed || !result.missing) break
          }
          if (token !== generation) break
        }
      } catch (e) { state.error = /^(http_\d+|invalid_\w+|network_or_response|missing_key|timeout|cancelled|input_limit)$/.test(e.message) ? e.message : 'unavailable' }
      finally { state.running = false }
    },
  }
}
