import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { DEFAULT_EMBEDDING } from '../lib/qwen-embedding.mjs'
test('语义设置提供隐私说明、只写密钥和当前库补齐按钮，提交固定库身份', async () => {
  let plugin, render, i = 0
  const d = { sessions: [], policy: {}, spec: [] }, calls = []
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useState: init => [i++ === 0 ? d : i === 4 ? {} : init, () => {}], useCallback: fn => fn, useEffect() {} }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React) } } }, fetch: async (url, options) => { calls.push([url, options]); return { json: async () => ({ ok: true, config: DEFAULT_EMBEDDING }) } } })
  plugin.apply({ get: () => ({ inject: (_, fn) => fn(), register: (_, fn) => { render = fn } }) })
  const section = render().children[1].type
  const walk = (node, result = []) => { if (node && typeof node === 'object') { result.push(node); for (const child of node.children || []) (Array.isArray(child) ? child : [child]).forEach(c => walk(c, result)) } return result }
  const component = walk(section()).find(n => n.type?.name === 'EmbeddingSettings').type
  const states = [{ configured: true, writable: true, indexed: 1, total: 2 }, DEFAULT_EMBEDDING, 'only-write-key', '', false]; i = 0
  React.useState = () => [states[i++], () => {}]
  const tree = component({ session: 'group-C', storeId: 'qq_99999_shared' }), nodes = walk(tree)
  assert.ok(JSON.stringify(tree).includes('发送给配置的云服务商'))
  assert.equal(nodes.find(n => n.props?.['aria-label'] === 'Embedding 密钥').props.type, 'password')
  await nodes.find(n => n.children?.includes('补齐当前库索引')).props.onClick()
  const request = calls.find(([url]) => url.endsWith('/index'))
  assert.equal(JSON.parse(request[1].body).storeId, 'qq_99999_shared')
  assert.ok(nodes.some(n => n.children?.includes('中断补齐')))
})
