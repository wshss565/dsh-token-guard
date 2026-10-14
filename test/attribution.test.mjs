import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { analyze, advise, cacheBand, uncachedRatio } from '../src/attribution.mjs'
import { newDay } from '../src/threshold.mjs'
import { ingest, writeBudget, listDays, readDay } from '../src/ledger.mjs'
import { dispatch } from '../src/commands.mjs'
import { exportPath } from '../src/ledger.mjs'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const bj = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 8, min)

/** 造一个可控的账本 */
function makeDay({ cost = { peak: 0, offpeak: 3 }, input = 600, output = 150, cacheRead = 6000, models = {} } = {}) {
  const d = newDay('2026-10-04')
  d.byTier.peak.costMicro = Math.round(cost.peak * 1e6)
  d.byTier.offpeak.costMicro = Math.round(cost.offpeak * 1e6)
  d.byTier.offpeak.turns = 1
  d.input = input; d.output = output; d.cacheRead = cacheRead
  d.turns = 1
  for (const [m, c] of Object.entries(models)) {
    d.byModel[m] = { costMicro: Math.round(c * 1e6), turns: 1, input, output, cacheRead }
  }
  return d
}

// ─────────────────────── 缓存分档 ───────────────────────
test('cacheBand: 按命中率分档', () => {
  assert.equal(cacheBand(0.95).level, 'good')
  assert.equal(cacheBand(0.75).level, 'ok')
  assert.equal(cacheBand(0.5).level, 'warn')
  assert.equal(cacheBand(0.1).level, 'bad')
  assert.equal(cacheBand(0).level, 'bad')
})

// ─────────────────────── 归因 ───────────────────────
test('analyze: token 构成全部为精确值', () => {
  const a = analyze(makeDay({ input: 100, output: 50, cacheRead: 850 }))
  assert.equal(a.composition.input, 100)
  assert.equal(a.composition.output, 50)
  assert.equal(a.composition.cacheRead, 850)
  assert.equal(a.composition.reasoningIsExact, true)
  assert.equal(a.tokens, 1000)
})

test('analyze: 缓存命中率与未缓存占比', () => {
  const a = analyze(makeDay({ input: 100, output: 50, cacheRead: 850 }))
  assert.ok(Math.abs(a.cache.hitRatio - 0.85) < 1e-9)
  assert.ok(Math.abs(a.uncached.ratio - 0.1) < 1e-9)
  assert.equal(a.cache.band, 'ok', '85% 属正常档（good 需>=90%）')
})

test('uncachedRatio: 总token 为 0 时不崩', () => {
  assert.equal(uncachedRatio(newDay('2026-10-04')), 0)
})

test('analyze: 时段占比之和为 1', () => {
  const a = analyze(makeDay({ cost: { peak: 1, offpeak: 3 } }))
  assert.ok(Math.abs(a.tiers.peak.ratio + a.tiers.offpeak.ratio - 1) < 1e-9)
  assert.ok(Math.abs(a.cost - 4) < 1e-9)
})

test('analyze: 模型按花费降序', () => {
  const a = analyze(makeDay({ models: { cheap: 1, pricey: 5, mid: 2 } }))
  assert.equal(a.models[0].model, 'pricey')
  assert.equal(a.models[1].model, 'mid')
  assert.equal(a.models[2].model, 'cheap')
})

// ─────────────────────── 建议 ───────────────────────
test('advise: 无用量时给中性提示', () => {
  const a = analyze(newDay('2026-10-04'))
  const s = advise(newDay('2026-10-04'), a)
  assert.deepEqual(s, ['用量结构正常，无需调整。'])
})

test('advise: 未缓存占比高时提示单价', () => {
  const d = makeDay({ input: 5000, output: 500, cacheRead: 2000 })
  const s = advise(d, analyze(d))
  assert.ok(s.some((x) => /未缓存输入/.test(x)), '应提示未缓存输入')
  assert.ok(s.some((x) => /单价最高/.test(x)), '应说明这部分单价最高')
})

test('advise: 缓存命中率低时给出可操作建议', () => {
  const d = makeDay({ input: 6000, output: 500, cacheRead: 2000 })
  const s = advise(d, analyze(d))
  assert.ok(s.some((x) => /缓存命中/.test(x)))
  assert.ok(s.some((x) => /固定模型|清空 KV 缓存/.test(x)), '应给出可操作建议')
})

test('advise: 高峰占比高时算出可省金额', () => {
  const d = makeDay({ cost: { peak: 4, offpeak: 0 } })
  const s = advise(d, analyze(d), { now: bj(2026, 10, 5, 15) })
  const line = s.find((x) => /高峰/.test(x))
  assert.ok(line, '应提到高峰')
  assert.match(line, /省 ¥2\.00/, '高峰 4 元应算出省 2 元')
  assert.match(line, /18:00/, '应提示距空闲还有多久')
})

test('advise: 全空闲时确认已享半价', () => {
  const d = makeDay({ cost: { peak: 0, offpeak: 3 } })
  const s = advise(d, analyze(d))
  assert.ok(s.some((x) => /全部用量都在空闲时段/.test(x)))
})

test('advise: unknown 模型不当作真实模型给建议', () => {
  const d = makeDay({ models: { unknown: 3 } })
  const s = advise(d, analyze(d))
  // 不应出现「全部用量来自 unknown」这类误导
  assert.ok(!s.some((x) => /来自 unknown/.test(x)))
  // 应说明未归因
  assert.ok(s.some((x) => /未归到具体模型/.test(x)))
})

test('advise: 预算超 80% 时提示占比', () => {
  const d = makeDay({ cost: { peak: 0, offpeak: 4.5 } })
  const s = advise(d, analyze(d), { budget: { dailyBudgetCny: 5 } })
  assert.ok(s.some((x) => /已用预算的 90%/.test(x)), '4.5/5 应提示 90%')
})

// ─────────────────────── 导出 ───────────────────────
test('export: 无记录时提示', () => {
  const home = mkdtempSync(join(tmpdir(), 'tg-exp-'))
  const out = dispatch(home, 'export')
  assert.match(out, /暂无记录/)
  rmSync(home, { recursive: true, force: true })
})

test('export: 生成可解析的 JSONL', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'tg-exp2-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  // 造一天
  const d = makeDay({ cost: { peak: 1, offpeak: 2 }, models: { 'deepseek-flash': 3 } })
  const { writeDay } = await import('../src/ledger.mjs')
  writeDay(home, d)
  writeBudget(home, { dailyBudgetCny: 50 })

  const out = dispatch(home, 'export')
  assert.match(out, /已导出 1 天/)

  const p = exportPath(home)
  assert.ok(existsSync(p), '应生成 export.jsonl')
  const lines = readFileSync(p, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)

  const o = JSON.parse(lines[0])
  for (const k of ['date', 'cost', 'tokens', 'turns', 'composition', 'cacheHitRatio', 'uncachedRatio', 'models', 'pricingVersion']) {
    assert.ok(k in o, `导出应含 ${k}`)
  }
  assert.equal(o.date, '2026-10-04')
  assert.ok(Math.abs(o.cost - 3) < 1e-6)
  assert.equal(o.models.length, 1)
  assert.equal(o.models[0].model, 'deepseek-flash')
})

test('export: 每行独立可解析（JSONL 语义）', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'tg-exp3-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const { writeDay } = await import('../src/ledger.mjs')
  for (const date of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    writeDay(home, { ...makeDay({ cost: { peak: 0, offpeak: 1 } }), date })
  }
  dispatch(home, 'export')

  const lines = readFileSync(exportPath(home), 'utf8').trim().split('\n')
  assert.equal(lines.length, 3)
  const dates = lines.map((l) => JSON.parse(l).date)
  assert.deepEqual(dates, ['2026-10-01', '2026-10-02', '2026-10-03'])
})
