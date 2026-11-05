// 固定标注与模拟向量服务评估；从不调用付费接口，不声称衡量真实Qwen质量。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createSemanticIndex } from '../lib/semantic-index.mjs'
import { DEFAULT_EMBEDDING, normalizeVector } from '../lib/qwen-embedding.mjs'
import { memories, samples, vectorFor } from '../tests/fixtures/hybrid-samples.mjs'
export async function evaluateHybrid() {
  const home = mkdtempSync(join(tmpdir(),'fish-hybrid-eval-'))
  process.env.DSH_HOME=home;process.env.DSH_HOST_MODULES=join(home,'no-host')
  const p=await import('../lib/index.js'),store=join(home,'fish-memory')
  mkdirSync(store,{recursive:true})
  const policy={...p.blank().policy,queryGate:0.8,factsMax:0,maxItems:6,maxChars:3000,autoExpand:false}
  writeFileSync(join(store,'evaluation.json'),JSON.stringify({memories,deleted:[],traces:[],policy,purgeEpoch:''}))
  let calls=0
  const server=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part
    const body=JSON.parse(text);calls++
    res.setHeader('content-type','application/json');res.end(JSON.stringify({output:{embeddings:body.input.texts.map((t,text_index)=>({text_index,embedding:vectorFor(t,body.parameters.dimension)}))}}))
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const config={...DEFAULT_EMBEDDING,enabled:true,dimensions:64,endpoint:`http://127.0.0.1:${server.address().port}/embedding`}
  const index=createSemanticIndex({home,config:()=>config,load:p.loadStore,storeId:p.singleStoreId,input:p.recallInput,getKey:async()=>'synthetic'})
  const now=Date.parse('2026-11-05T08:00:00Z'),latencies=[],keywordLatencies=[],results=[]
  try{
    p.recall(p.loadStore('evaluation'),samples[0].query,now,'evaluation') // 词典初始化不计入逐查询延迟
    await index.fill('evaluation')
    for(const sample of samples){
      const data=p.loadStore('evaluation'),before=performance.now()
      const baseline=p.recall(data,sample.query,now,'evaluation')
      keywordLatencies.push(performance.now()-before)
      const start=performance.now(),semantic=await index.prepare('evaluation',sample.query)
      const hybrid=p.recall(data,sample.query,now,'evaluation',semantic)
      latencies.push(performance.now()-start)
      results.push({sample,semantic,baseline,hybrid})
    }
    const metrics=lists=>{
      let relevant=0,returned=0,missed=0,emptyCorrect=0
      lists.forEach((ids,i)=>{
        const expected=results[i].sample.relevant;returned+=ids.length;relevant+=ids.filter(id=>expected.includes(id)).length
        missed+=expected.filter(id=>!ids.includes(id)).length
        if(!expected.length&&!ids.length)emptyCorrect++
      })
      return {relevant,returned,precision:returned?relevant/returned:1,missed,emptyCorrect}
    }
    const thresholds=[0.65,0.7,0.75,0.8,0.85].map(threshold=>({threshold,...metrics(results.map(({sample})=>p.recall(p.loadStore('evaluation'),sample.query,now,'evaluation',{scores:new Map(memories.map((m,i)=>[m.id,normalizeVector(vectorFor(sample.query),64)[i]])),minSimilarity:threshold}).selected.map(r=>r.m.id)))}))
    const hybridIds=results.map(r=>r.hybrid.selected.map(row=>row.m.id))
    const maxCalibrated=results.map(({hybrid})=>hybrid.selected.slice().sort((a,b)=>{
      const score=r=>Math.max(r.s.keywordAccepted?r.s.C:0,r.s.semanticAccepted?0.3+0.7*(r.s.semantic-config.minSimilarity)/(1-config.minSimilarity):0)*r.s.multiplier
      return score(b)-score(a)
    }).map(r=>r.m.id))
    const sorted=latencies.slice().sort((a,b)=>a-b),kwSorted=keywordLatencies.slice().sort((a,b)=>a-b)
    const before=calls;await index.prepare('evaluation',samples[0].query)
    return {scope:'模拟协议与排序管线；不是Qwen实测质量',samples:samples.length,expectedRelevant:samples.reduce((n,s)=>n+s.relevant.length,0),thresholds,
      keyword:metrics(results.map(r=>r.baseline.selected.map(row=>row.m.id))),hybrid:metrics(hybridIds),maxCalibrated:metrics(maxCalibrated),
      keywordLatencyMs:{p50:+kwSorted[Math.floor(kwSorted.length*.5)].toFixed(2),p95:+kwSorted[Math.floor(kwSorted.length*.95)].toFixed(2)},latencyMs:{p50:+sorted[Math.floor(sorted.length*.5)].toFixed(2),p95:+sorted[Math.floor(sorted.length*.95)].toFixed(2)},calls:{documents:1,queries:calls-1,repeatedQuery:calls-before},
      details:results.map((r,i)=>({query:r.sample.query,expected:r.sample.relevant,keyword:r.baseline.selected.map(row=>row.m.id),hybrid:hybridIds[i]}))}
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) console.log(JSON.stringify(await evaluateHybrid(),null,2))
