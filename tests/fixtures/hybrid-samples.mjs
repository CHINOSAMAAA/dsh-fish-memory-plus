// 人工标注相关对象；余弦为模拟服务固定返回，只用于管线/门槛回归，不代表真实Qwen质量。
export const memories = [
  { id: 'allergy', text: '我对花生过敏，不能吃花生。', at: '2020-01-01T00:00:00Z' },
  { id: 'project', text: '青鹭项目的发布分支叫 release-egret。', at: '2026-11-01T00:00:00Z' },
  { id: 'drink', text: '我晚上不喝含咖啡因的饮料。', at: '2026-10-01T00:00:00Z' },
  { id: 'music', text: '我偏爱巴赫的古典音乐。', at: '2026-10-02T00:00:00Z' },
  { id: 'sun', text: '今天在公园晒了太阳。', at: '2026-11-05T00:00:00Z' },
].map(m => ({ ...m, importance: 0.5, category: 'event', emotion: 0, createdAt: m.at }))
export const samples = [
  { query: '花生过敏的事情还记得吗', relevant: ['allergy'], scores: { allergy: 0.96 } },
  { query: '吃这种坚果会起疹子，能吃吗', relevant: ['allergy'], scores: { allergy: 0.83, sun: 0.68 } },
  { query: '哪种食物会引起我的免疫反应', relevant: ['allergy'], scores: { allergy: 0.78 } },
  { query: '青鹭项目的发布分支叫什么', relevant: ['project'], scores: { project: 0.97 } },
  { query: 'release-egret 是哪个分支', relevant: ['project'], scores: { project: 0.94 } },
  { query: '睡前可以喝提神的东西吗', relevant: ['drink'], scores: { drink: 0.86 } },
  { query: '推荐我偏爱的作曲家的唱片', relevant: ['music'], scores: { music: 0.81 } },
  { query: '最近那次户外休息在哪里', relevant: ['sun'], scores: { sun: 0.76 } },
  { query: '火星的引力常数是多少', relevant: [], scores: { sun: 0.71, allergy: 0.35 } },
  { query: '如何证明黎曼猜想', relevant: [], scores: { project: 0.73 } },
]
export function vectorFor(text, dimensions = 64) {
  const v = Array(dimensions).fill(0)
  const memory = memories.findIndex(m => m.text === text)
  if (memory >= 0) { v[memory] = 1; return v }
  const query = samples.find(s => s.query === text)
  if (!query) { v[dimensions - 1] = 1; return v }
  let norm = 0
  memories.forEach((m, i) => { v[i] = query.scores[m.id] || 0; norm += v[i] ** 2 })
  v[dimensions - 1] = Math.sqrt(Math.max(0, 1 - norm))
  return v
}
