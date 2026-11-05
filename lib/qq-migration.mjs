import { readFileSync, readdirSync, mkdirSync, copyFileSync, constants } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { qqScope } from './qq-scope.mjs'
const digest = data => createHash('sha256').update(data).digest('hex')

// 不依据会话标题、当前绑定或正文猜测旧条目的归属；只接受能与桥内消息凭据逐项对上的来源。
export function migrateQQ({ home, settings, load, save, execute = false }) {
  const dir = join(home, 'fish-memory')
  let names = []
  try { names = readdirSync(dir).filter(n => n.endsWith('.json') && !n.startsWith('qq_')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const plan = [], pending = [], backups = []
  for (const name of names) {
    const path = join(dir, name), bytes = readFileSync(path)
    let raw
    try { raw = JSON.parse(bytes) } catch { pending.push({ file: name, reason: 'JSON 损坏，原件保留' }); continue }
    const sid = name.slice(0, -5)
    const scope = qqScope(home, sid, settings)
    if (!scope && !sid.startsWith('ws_') && ![...(raw.memories || []), ...(raw.deleted || [])].some(m => m.qqSource)) continue
    for (const [field, entries] of [['memories', raw.memories || []], ['deleted', raw.deleted || []]]) {
      for (const m of entries) {
        const src = m.qqSource
        const trusted = src?.messageId && qqScope(home, src.sessionId, settings, src.messageId)
        if (!trusted || trusted.blocked || !trusted.source.messageId ||
            ['botId', 'type', 'chatId'].some(k => src[k] !== trusted.source[k]) ||
            JSON.stringify(src.senders) !== JSON.stringify(trusted.source.senders) ||
            ![trusted.source.subject, 'record:' + m.id].includes(src.subject)) {
          pending.push({ file: name, id: m.id, text: String(m.text || '').slice(0, 120), reason: '来源不明确或历史凭据不足，需人工核对' })
          continue
        }
        const id = 'migration_' + digest(JSON.stringify([name, m.id, src]))
        plan.push({ file: name, field, id, storeId: trusted.writeId, memory: { ...m, id, qqSource: { ...src, storeId: trusted.writeId } } })
      }
    }
  }
  let added = 0, skipped = 0
  if (execute) {
    const backupDir = join(home, 'fish-memory-qq-migration-backup')
    mkdirSync(backupDir, { recursive: true })
    // 全部原件先备份，备份失败时不开始导入；保留内容寻址备份，重复运行不覆盖。
    for (const name of new Set([...plan.map(p => p.file), ...pending.map(p => p.file)])) {
      const path = join(dir, name), backup = join(backupDir, digest(readFileSync(path)) + '-' + name)
      try { copyFileSync(path, backup, constants.COPYFILE_EXCL) } catch (e) { if (e.code !== 'EEXIST') throw e }
      backups.push(backup)
    }
    for (const item of plan) {
      const target = load(item.storeId)
      if ((target.migrations || []).includes(item.id)) { skipped++; continue }
      target[item.field].push(item.memory)
      target.migrations = [...(target.migrations || []), item.id]
      save(item.storeId, target)
      added++
    }
  }
  return { ok: true, preview: !execute, candidates: plan.map(({ file, field, id, storeId }) => ({ file, field, id, storeId })), pending, added, skipped, backups }
}
