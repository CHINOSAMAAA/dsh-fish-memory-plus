import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateHybrid } from '../scripts/evaluate-hybrid.mjs'
test('固定标注样本：门槛扫描、候选融合、漏召回、调用数和延迟', async () => {
  const report = await evaluateHybrid()
  assert.equal(report.samples, 10)
  assert.equal(report.keyword.missed, 2)
  assert.equal(report.hybrid.missed, 0)
  assert.equal(report.hybrid.precision, 1)
  assert.equal(report.hybrid.emptyCorrect, 2)
  assert.deepEqual(report.hybrid, report.maxCalibrated)
  assert.ok(report.thresholds.find(x => x.threshold === 0.7).precision < report.hybrid.precision)
  assert.deepEqual(report.calls, { documents: 1, queries: 10, repeatedQuery: 0 })
  assert.ok(Number.isFinite(report.latencyMs.p95))
})
