import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('设置界面渲染QQ配置及迁移入口，保存使用明确字段', async () => {
  const d={ok:true,sessions:[],policy:{},spec:[],qqOwner:'10001',qqIsolatedGroups:['20001']}
  let index=0,render,plugin;const requests=[]
  const React={createElement:(type,props,...children)=>({type,props,children}),useState:init=>[index++===0?d:index===4?{}:init,()=>{}],useCallback:fn=>fn,useEffect(){}}
  const slots={inject:(_,fn)=>fn(),register:(_,fn)=>{render=fn}}
  vm.runInNewContext(readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:({factory})=>{plugin=factory(()=>React)}}},fetch:async(url,options)=>{requests.push([url,options]);return{json:async()=>({ok:true})}}})
  plugin.apply({get:()=>slots})
  const Section=render().children[1].type,tree=Section()
  const nodes=[];function visit(x){if(!x||typeof x!=='object')return;nodes.push(x);for(const c of x.children||[])Array.isArray(c)?c.forEach(visit):visit(c)}visit(tree)
  assert.ok(nodes.some(x=>x.props?.['aria-label']==='主人 QQ'))
  assert.ok(nodes.some(x=>x.props?.['aria-label']==='隔离群号'))
  assert.ok(nodes.some(x=>x.children?.includes('预览旧数据迁移')))
  await nodes.find(x=>x.children?.includes('保存 QQ 设置')).props.onClick()
  const payload=JSON.parse(requests[0][1].body)
  assert.equal(payload.qqOwner,'10001');assert.equal(payload.qqIsolatedGroups,'20001')
})
