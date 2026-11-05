import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const key = value => String(value || '').replace(/^session-/, '')
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
export const libraryId = (bot, type, chat, isolated = []) => type === '私聊' ? `qq_${bot}_private_${chat}` : isolated.includes(chat) ? `qq_${bot}_group_${chat}` : `qq_${bot}_shared`
export const subjectKey = m => m?.qqSource ? JSON.stringify([m.qqSource.storeId || m.storeId, m.qqSource.botId, m.qqSource.type, m.qqSource.chatId, m.qqSource.subject]) : ''

export function latestUserId(session) {
  const events = session?.snapshotEvents?.() || []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if ((e.type || e.kind) !== 'user/message') continue
    const message = e.data?.message || e.data || e.message || e.payload
    const source = message?.source
    // 宿主动态上下文也是 user/message；只跳过已核对契约的机器快照，不跳过未知输入。
    if (['runtime-context', 'time-context'].includes(source?.kind) || (source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt')) continue
    return String(message?.id || '')
  }
  return ''
}

// source 标题、昵称、模型参数一律不参与授权；只认桥落盘的独占映射及本轮宿主消息 ID。
export function qqScope(home, sid, settings = {}, messageId = '') {
  const config = read(join(home, 'qq-bridge-config.json'))
  const registry = read(join(home, 'qq-bridge-memory-sources.json'))
  const sessions = registry?.sessions || {}
  const rows = Array.isArray(config?.绑定) && config.绑定.length ? config.绑定 : [
    { 类型: '私聊', 号码: config?.私聊QQ, 会话: config?.私聊会话 || config?.目标会话 },
    { 类型: '群', 号码: config?.群号, 会话: config?.群会话 },
  ].filter(b => b.号码 && b.会话)
  const matching = rows.filter(b => key(b.会话) === key(sid))
  const known = sessions[key(sid)]
  if (!matching.length && !known) return null
  const isolated = settings.qqIsolatedGroups || []
  const endpoint = hash([config?.NapCat, config?.令牌 || ''])
  const valid = (entry, row) => entry && !entry.unverified && row && /^\d+$/.test(entry.botId) && /^\d+$/.test(entry.chatId) &&
    ['私聊', '群'].includes(entry.type) && row.开 !== false && row.类型 === entry.type && String(row.号码) === entry.chatId &&
    entry.endpoint === endpoint && rows.filter(b => key(b.会话) === key(row.会话)).length === 1 &&
    rows.filter(b => b.类型 === row.类型 && String(b.号码) === String(row.号码)).length === 1
  const stamp = hash([rows, endpoint, settings.qqOwner || '', isolated, sessions])
  if (matching.length !== 1 || !valid(known, matching[0])) return { qq: true, blocked: true, stamp }
  const writeId = libraryId(known.botId, known.type, known.chatId, isolated)
  const receipt = messageId && ((known.receipts || []).find(r => r.id === messageId) || (known.messageId === messageId ? { senders: known.senders } : null))
  const trusted = Boolean(receipt)
  const senders = receipt?.senders || []
  const owner = trusted && known.type === '私聊' && known.chatId === settings.qqOwner &&
    senders.length === 1 && senders[0] === settings.qqOwner
  const readIds = new Set([writeId])
  if (owner) for (const [session, entry] of Object.entries(sessions)) {
    const row = rows.find(b => key(b.会话) === session)
    if (!valid(entry, row) || entry.botId !== known.botId) continue
    // 其他人的私聊不属于主人的跨库授权集合。
    if (entry.type === '群') readIds.add(libraryId(entry.botId, entry.type, entry.chatId, isolated))
  }
  const source = { botId: known.botId, type: known.type, chatId: known.chatId, sessionId: String(sid),
    messageId: trusted ? messageId : '', senders,
    role: owner ? 'owner' : known.type === '群' ? 'member' : 'peer',
    subject: trusted ? known.type === '私聊' ? 'peer:' + known.chatId : 'message:' + messageId : 'unknown' }
  return { qq: true, blocked: false, writeId, readIds: [...readIds].sort(), owner, source, stamp }
}
