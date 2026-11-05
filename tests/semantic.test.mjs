import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createSemanticIndex } from '../lib/semantic-index.mjs'
import { embed, embeddingConfig, DEFAULT_EMBEDDING, hash } from '../lib/qwen-embedding.mjs'
import { memories, samples, vectorFor } from './fixtures/hybrid-samples.mjs'
const home = mkdtempSync(join(tmpdir(), 'fish-semantic-'))
process.env.DSH_HOME = home; process.env.DSH_HOST_MODULES = join(home, 'no-host')
const p = await import('../lib/index.js')
const requests = [], keys = new Map(), routes = new Map(), agents = []
let responseMode = 'ok', release = null, reached = null
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  const b = JSON.parse(body); requests.push(b)
  if (responseMode === 'hold') { reached?.(); await new Promise(r => { release = r }) }
  if (responseMode === 'timeout') { setTimeout(() => res.end('{}'), 250).unref(); return }
  if (responseMode === 'disconnect') { req.socket.destroy(); return }
  if (responseMode === '429') { res.writeHead(429); res.end('secret-key must never escape'); return }
  const rows = b.input.texts.map((text, text_index) => ({ text_index, embedding: vectorFor(text, b.parameters.dimension) }))
  if (responseMode === 'count') rows.pop()
  if (responseMode === 'duplicate') rows.push(rows[0])
  if (responseMode === 'duplicateIndex') rows[1].text_index = 0
  if (responseMode === 'index') rows[0].text_index = -1
  if (responseMode === 'dimension') rows[0].embedding = [1]
  if (responseMode === 'zero') rows[0].embedding.fill(0)
  if (responseMode === 'nan') rows[0].embedding[0] = null
  res.setHeader('content-type','application/json'); res.end(JSON.stringify({ output: { embeddings: rows.reverse() } }))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
test.after(() => server.close())
const c = { ...DEFAULT_EMBEDDING, enabled: true, dimensions: 64, endpoint: `http://127.0.0.1:${server.address().port}/embedding`, timeoutMs: 1000 }
const settings = { embedding: c, policy: { queryGate: 0.8, factsMax: 0, maxItems: 6, maxChars: 3000, autoExpand: false } }
const put = (name, value) => writeFileSync(join(home, name), JSON.stringify(value))
put('fish-memory-config.json', settings)
mkdirSync(join(home,'fish-memory'), { recursive: true })
function seed(sid, items = memories) { put('fish-memory/'+sid+'.json', { version:2, purgeEpoch:'', policy: settings.policy, memories:structuredClone(items), deleted:[], traces:[] }) }
const svc = createSemanticIndex({ home, config:()=>settings.embedding, load:p.loadStore, storeId:p.singleStoreId, input:p.recallInput, getKey:async()=> 'synthetic-key' })
const ctx = { effect:fn=>fn(), on:()=>()=>{}, interval:()=>()=>{}, get:name=>name==='agentLoop'?{}:name==='credentials'?{ resolve:async()=>({value:'synthetic-key'}),set:async(ref,key)=>keys.set(ref,key),unset:async ref=>keys.delete(ref) }:null,
  agents:{ list:()=>agents,get:id=>agents.find(a=>a.session.id===id) },sessions:{list:()=>[]},webServer:{register:({path,handler})=>{routes.set(path,handler);return()=>{}}} }
async function post(path, body) {
  let result
  await routes.get('/dsh-fish-memory'+path)({ method:'POST',url:path,async *[Symbol.asyncIterator](){yield JSON.stringify(body)} },{writeHead(){},end:t=>result=JSON.parse(t)})
  return result
}
function mount(sid) {
  const events=[], listeners=new Map(), providers=new Map()
  const agent={session:{id:sid,header:{id:sid},snapshotEvents:()=>events},ctx:{on:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name)},systemPrompt:{section:()=>()=>{},context:provider=>{providers.set(provider.name,provider);return()=>{}},assemble:async()=>{}}}}
  agents.push(agent);p.apply(ctx)
  return { agent, events, listeners, providers, async assemble(query, id='query-'+sid) {
    listeners.get('agent/inbox/claimed')?.({message:{id,role:'user',content:[{type:'text',text:query}],source:{kind:'user'}}})
    const assembly={contexts:[...providers.values()].map(provider=>({name:provider.name,text:provider.text()}))}
    const out=await listeners.get('system-prompt/assemble')(assembly,{},async()=>assembly)
    return out.contexts.find(x=>x.name==='memory').text
  } }
}
seed('main')
p.apply(ctx)

test('DashScope协议：query/document、乱序索引、有限非零向量和异常返回校验',async()=>{
  assert.equal((await embed(c,memories.slice(0,2).map(m=>m.text),'document',async()=>'synthetic-key')).length,2)
  assert.equal(requests.at(-1).parameters.text_type,'document')
  for(const mode of ['count','duplicate','index','dimension','zero','nan']) {
    responseMode=mode;await assert.rejects(embed(c,[samples[0].query],'query',async()=>'synthetic-key'),/invalid/)
  }
  responseMode='duplicateIndex';await assert.rejects(embed(c,memories.slice(0,2).map(m=>m.text),'document',async()=>'synthetic-key'),/invalid_index/)
  responseMode='ok';assert.throws(()=>embeddingConfig({...c,endpoint:'https://user:secret@example.com'}))
})
test('旧库分批续跑，正文与trace不含向量；有效向量不重复生成',async()=>{
  const before=readFileSync(join(home,'fish-memory/main.json'),'utf8')
  const start=requests.length
  assert.equal((await svc.fill('main',2)).completed,2);assert.equal((await svc.fill('main',10)).completed,3);assert.equal((await svc.fill('main',10)).completed,0)
  assert.equal(requests.length-start,2)
  assert.equal(readFileSync(join(home,'fish-memory/main.json'),'utf8'),before)
  assert.equal(svc.status('main').indexed,5)
})
test('同义改写与专名独立召回，无关返回空；关闭/失败仍等价关键词，召回不强化',async()=>{
  const before=p.loadStore('main').memories
  for(const sample of samples) {
    const sem=await svc.prepare('main',sample.query)
    const r=p.recall(p.loadStore('main'),sample.query,Date.now(),'main',sem)
    if(sample.relevant.length) assert.ok(r.selected.some(row=>sample.relevant.includes(row.m.id)),sample.query)
    else assert.equal(r.selected.length,0,sample.query)
  }
  assert.deepEqual(p.loadStore('main').memories,before)
  const query=samples[1].query, original=p.recall(p.loadStore('main'),query,Date.now(),'main')
  settings.embedding.enabled=false;assert.equal(await svc.prepare('main',query),null)
  assert.deepEqual(p.recall(p.loadStore('main'),query,Date.now(),'main').selected.map(r=>r.m.id),original.selected.map(r=>r.m.id))
  settings.embedding.enabled=true
})
test('修改、删除、清库和换模型使向量立即无效，旧后台任务不可写回',async()=>{
  const data=p.loadStore('main');data.memories[0].text='修改后的正文';p.saveStore('main',data)
  assert.equal(svc.status('main').indexed,4)
  const saved=p.loadStore('main');saved.deleted.push({...saved.memories.pop(),deletedAt:new Date().toISOString()});p.saveStore('main',saved)
  assert.equal(svc.status('main').total,4)
  settings.embedding.model='text-embedding-v3';assert.equal(svc.status('main').indexed,0);settings.embedding.model='text-embedding-v4'
  seed('delayed',[memories[0]])
  responseMode='hold';const ready=new Promise(r=>{reached=r});const work=svc.fill('delayed');await ready
  const purged=p.loadStore('delayed');purged.memories=[];p.saveStore('delayed',purged,{raw:true})
  responseMode='ok';release();assert.equal((await work).completed,0);assert.equal(svc.status('delayed').indexed,0)
})
test('同轮await组装首次就命中；同查询并发不重复请求；超时/429/异常/断网回退',async()=>{
  seed('request');await svc.fill('request')
  const h=mount('request'),query=samples[2].query,start=requests.length
  assert.equal(p.recall(p.loadStore('request'),query,Date.now(),'request').selected.length,0,'用关键词确实漏掉的查询验证同轮语义命中')
  const texts=await Promise.all([h.assemble(query),h.assemble(query),h.assemble(query)])
  assert.ok(texts.every(text=>text.includes(memories[0].text)))
  assert.equal(requests.length-start,1)
  for(const mode of ['timeout','429','zero','disconnect']) {
    responseMode=mode
    settings.embedding={...c,timeoutMs:100,revision:(settings.embedding.revision||0)+1};put('fish-memory-config.json',settings)
    await svc.fill('request').catch(()=>{})
    // 索引使用正常响应，故障只发生在本轮查询。
    responseMode='ok';await svc.fill('request');responseMode=mode
    const text=await h.assemble(samples[3].query+' '+mode)
    assert.ok(text.includes(memories[1].text));assert.doesNotMatch(text,/synthetic-key|secret-key/)
    assert.ok(p.loadStore('request').traces.at(-1).semantic.fallback)
  }
  responseMode='ok';settings.embedding={...c,revision:100};put('fish-memory-config.json',settings)
})
test('设置只写宿主密钥，响应与普通配置无密钥；索引补齐有明确原库参数',async()=>{
  const result=await post('/embedding/settings',{config:c,key:'synthetic-private-key'})
  assert.equal(result.ok,true);assert.ok([...keys.values()].includes('synthetic-private-key'))
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private-key/)
  assert.doesNotMatch(readFileSync(join(home,'fish-memory-config.json'),'utf8'),/synthetic-private-key/)
  assert.equal((await post('/embedding/index',{session:'request',storeId:'wrong'})).ok,false)
})

test('复用QQ可读库：关键词/向量/常驻事实/查询缓存均不越权',async()=>{
  settings.embedding={...c,revision:300};settings.qqOwner='10001';settings.qqIsolatedGroups=['20001','20002'];put('fish-memory-config.json',settings)
  const bindings=[['owner','私聊','10001'],['other','私聊','10002'],['A','群','20001'],['B','群','20002'],['C','群','20003'],['D','群','20004']].map(([会话,类型,号码])=>({会话,类型,号码}))
  put('qq-bridge-config.json',{NapCat:'http://qq-fixture',绑定:bindings})
  put('qq-bridge-memory-sources.json',{sessions:Object.fromEntries(bindings.map(b=>[b.会话,{botId:'99999',type:b.类型,chatId:b.号码,endpoint:hash(['http://qq-fixture','']),messageId:'trusted-'+b.会话,senders:[b.号码]}]))})
  for(const b of bindings){
    const data=p.loadStore(b.会话);data.memories=[{...memories[0],category:'stable_profile'}];p.saveStore(b.会话,data);await svc.fill(b.会话)
  }
  const session=id=>({snapshotEvents:()=>[{type:'user/message',data:{id:'trusted-'+id}}]})
  const run=async id=>{
    const query=samples[1].query,input=p.recallInput(id,session(id)),sem=await svc.prepare(id,query,session(id))
    return {sem,selected:p.recall({...input.data,policy:{...input.data.policy,factsMax:6}},query,Date.now(),id,sem).selected}
  }
  assert.deepEqual(new Set((await run('owner')).sem.scores.keys()),new Set(['qq_99999_private_10001/allergy','qq_99999_group_20001/allergy','qq_99999_group_20002/allergy','qq_99999_shared/allergy']))
  for(const [id,library] of [['A','qq_99999_group_20001'],['B','qq_99999_group_20002'],['C','qq_99999_shared'],['D','qq_99999_shared'],['other','qq_99999_private_10002']]){
    const r=await run(id);assert.ok(r.selected.every(row=>row.m.storeId===library));assert.deepEqual([...r.sem.scores.keys()],[library+'/allergy'])
  }
  settings.qqIsolatedGroups.push('20003');put('fish-memory-config.json',settings)
  assert.equal((await run('C')).sem.fallback,'missing_vectors')
  assert.equal((await run('C')).selected.length,0)
  settings.qqIsolatedGroups.pop();settings.qqOwner='10002';put('fish-memory-config.json',settings)
  assert.deepEqual([...((await run('owner')).sem.scores.keys())],['qq_99999_private_10001/allergy'])
})

test('等待中的索引任务复核正文、跳过标记及模型；中断可续跑且不清正文',async()=>{
  for(const change of ['edit','skip','model','stop']){
    responseMode='ok';seed('race-'+change,[memories[0]])
    responseMode='hold';const ready=new Promise(r=>{reached=r});const work=svc.fill('race-'+change);await ready
    const data=p.loadStore('race-'+change)
    if(change==='edit') {data.memories[0].text='新的正文';p.saveStore('race-'+change,data)}
    if(change==='skip') {data.memories[0].refinedSkip=true;p.saveStore('race-'+change,data)}
    if(change==='model') settings.embedding.model='text-embedding-v3'
    if(change==='stop') svc.reset()
    responseMode='ok';release()
    if(change==='stop') await assert.rejects(work,/cancelled/)
    else assert.equal((await work).completed,0)
    if(change==='model') settings.embedding.model='text-embedding-v4'
    assert.equal(svc.status('race-'+change).indexed,0)
    assert.equal(p.loadStore('race-'+change).memories.length,1)
  }
  seed('resume',[memories[0],memories[1]])
  await svc.fill('resume',1);svc.reset();await svc.run(['resume'])
  assert.equal(svc.status('resume').indexed,2)
  svc.rebuild('resume');assert.equal(svc.status('resume').indexed,0)
  assert.equal(p.loadStore('resume').memories.length,2)
})
test('慢凭据也受本轮超时限制；API失败不妨碍先保存正文',async()=>{
  const start=Date.now()
  await assert.rejects(embed({...c,timeoutMs:100},['query'],'query',()=>new Promise(()=>{})),/timeout/)
  assert.ok(Date.now()-start<500)
  settings.embedding={...c,revision:401};put('fish-memory-config.json',settings)
  responseMode='429';seed('save-first',[])
  const data=p.loadStore('save-first');data.memories.push({...memories[0],text:'先保存的正文'})
  p.saveStore('save-first',data)
  assert.equal(p.loadStore('save-first').memories[0].text,'先保存的正文')
  await new Promise(r=>setTimeout(r,30))
  assert.ok(requests.some(r=>r.parameters.text_type==='document'&&r.input.texts.includes('先保存的正文')))
  assert.equal(svc.status('save-first').indexed,0)
  responseMode='ok'
})

test('正文版本变化重新筛候选，但同一查询不重复生成查询向量',async()=>{
  settings.embedding={...c,revision:501};put('fish-memory-config.json',settings);seed('query-cache')
  await svc.fill('query-cache')
  const query=samples[2].query
  assert.ok((await svc.prepare('query-cache',query)).scores.has('allergy'))
  const before=requests.filter(r=>r.parameters.text_type==='query').length
  const data=p.loadStore('query-cache');data.memories[0].text=memories[1].text;p.saveStore('query-cache',data)
  const result=await svc.prepare('query-cache',query)
  assert.equal(result.scores.has('allergy'),false,'不能复用旧候选结果')
  assert.equal(requests.filter(r=>r.parameters.text_type==='query').length,before)
})
