import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPeak, costOf, msUntilOffpeak, describeOffpeakWait, tierOf } from '../src/pricing.mjs'
import { newDay, addTurn, evaluate, checkNotify, costOfDay, totalTokens } from '../src/threshold.mjs'

// 北京时间构造：给定 Y/M/D/H（北京时间），返回毫秒时间戳
const bj = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 8, min)

// ─────────────────────────── pricing: 时段判定 ───────────────────────────
test('isPeak: 工作日 10:00 是高峰', () => {
  assert.equal(isPeak(bj(2026, 10, 5, 10)), true)
  assert.equal(tierOf(bj(2026, 10, 5, 10)), 'peak')
})
test('isPeak: 工作日 15:00 是高峰', () => {
  assert.equal(isPeak(bj(2026, 10, 5, 15)), true)
})
test('isPeak: 工作日 08:59 空闲 / 09:00 高峰（边界）', () => {
  assert.equal(isPeak(bj(2026, 10, 5, 8, 59)), false)
  assert.equal(isPeak(bj(2026, 10, 5, 9, 0)), true)
})
test('isPeak: 12:00 空闲 / 14:00 高峰（午休边界）', () => {
  assert.equal(isPeak(bj(2026, 10, 5, 11, 59)), true)
  assert.equal(isPeak(bj(2026, 10, 5, 12, 0)), false)
  assert.equal(isPeak(bj(2026, 10, 5, 14, 0)), true)
})
test('isPeak: 18:00 转空闲（边界）', () => {
  assert.equal(isPeak(bj(2026, 10, 5, 17, 59)), true)
  assert.equal(isPeak(bj(2026, 10, 5, 18, 0)), false)
})
test('isPeak: 周六周日全天空闲', () => {
  for (const h of [0, 9, 10, 14, 17, 23]) {
    assert.equal(isPeak(bj(2026, 10, 3, h)), false, `周六 ${h}点应空闲`)
    assert.equal(isPeak(bj(2026, 10, 4, h)), false, `周日 ${h}点应空闲`)
  }
})

test('isPeak: 时段判定不受系统 TZ 影响', () => {
  const cases = [bj(2026, 10, 5, 10), bj(2026, 10, 5, 13), bj(2026, 10, 3, 10)]
  const orig = process.env.TZ
  const results = []
  for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/London']) {
    process.env.TZ = tz
    results.push(cases.map((ts) => isPeak(ts)))
  }
  process.env.TZ = orig
  assert.deepEqual(results[0], results[1])
  assert.deepEqual(results[0], results[2])
  assert.deepEqual(results[0], results[3])
  assert.deepEqual(results[0], [true, false, false])
})

// ─────────────────────────── pricing: 三段计价 ───────────────────────────
const flashUsage = { input: 93147, output: 13543, cacheRead: 417792, cacheWrite: 0 }

test('★ 计价公式与官方账本精确一致（空闲时段实测回归）', () => {
  // 来源：~/.dsh/.dshw-usage.json 第一条事件
  // tokens=524482 恰好等于 input+output+cacheRead，且 cost 与本公式分位一致
  const r = { input: 93147, output: 13543, cacheRead: 417792 }
  const p = costOf(r, 'deepseek-flash', bj(2026, 10, 3, 13, 40))
  assert.equal(p.tier, 'offpeak')
  assert.equal(p.cost, 0.15567484, `实得 ${p.cost}`)
  assert.equal(totalTokensOf(r), 524482)
})
function totalTokensOf(r) { return r.input + r.output + r.cacheRead }

test('★ 第二条官方事件同样精确一致', () => {
  const r = { input: 22206, output: 11890, cacheRead: 293888 }
  const p = costOf(r, 'deepseek-flash', bj(2026, 10, 3, 13, 54))
  assert.equal(p.cost, 0.07564376, `实得 ${p.cost}`)
  assert.equal(totalTokensOf(r), 327984)
})

test('计价: 高峰时段成本是空闲的 2 倍', () => {
  const off = costOf(flashUsage, 'deepseek-flash', bj(2026, 10, 3, 13))
  const peak = costOf(flashUsage, 'deepseek-flash', bj(2026, 10, 5, 10))
  assert.ok(Math.abs(peak.cost - off.cost * 2) < 1e-12)
  assert.equal(peak.tier, 'peak')
})

test('计价: 未知模型回落到 v4-pro 并标注', () => {
  const p = costOf(flashUsage, 'no-such-model', Date.now())
  assert.equal(p.estimatedPrice, true)
  const ref = costOf(flashUsage, 'deepseek-v4-pro', Date.now())
  assert.equal(p.cost, ref.cost)
})

test('计价: 字段缺失/ null 按 0 处理不抛错', () => {
  const p = costOf({ input: null, output: undefined, cacheRead: NaN }, 'deepseek-flash', Date.now())
  assert.equal(p.cost, 0)
})

test('计价: 缓存命中为主时远低于全价（三段计价生效）', () => {
  const heavyCache = { input: 1000, output: 500, cacheRead: 500000 }
  const p = costOf(heavyCache, 'deepseek-flash', bj(2026, 10, 3, 13))
  const naive = (p.unit.miss * (1000 + 500 + 500000)) / 1e6
  assert.ok(p.cost < naive / 5, `分三段 ${p.cost} 应远低于合并算 ${naive}`)
})

// ─────────────────────── pricing: 距空闲时段 ───────────────────────
test('msUntilOffpeak: 空闲时为 0', () => {
  assert.equal(msUntilOffpeak(bj(2026, 10, 3, 13)), 0)
  assert.equal(describeOffpeakWait(bj(2026, 10, 3, 13)), '当前已是空闲时段')
})
test('msUntilOffpeak: 上午高峰距 12:00', () => {
  const ms = msUntilOffpeak(bj(2026, 10, 5, 10, 30))
  assert.equal(ms, 90 * 60_000)
  assert.match(describeOffpeakWait(bj(2026, 10, 5, 10, 30)), /12:00.*1 小时 30 分/)
})
test('msUntilOffpeak: 下午高峰距 18:00', () => {
  const ms = msUntilOffpeak(bj(2026, 10, 5, 15))
  assert.equal(ms, 3 * 3600_000)
  assert.match(describeOffpeakWait(bj(2026, 10, 5, 15)), /18:00.*3 小时/)
})

// ─────────────────────────── threshold: 双轨判定 ───────────────────────────
/** 构造一个只含指定花费的账本（走byTier，与真实累加路径一致） */
function dayWith(cny, tokens = 0) {
  const d = newDay('2026-10-04')
  d.byTier.offpeak.costMicro = Math.round(cny * 1e6)
  d.byTier.offpeak.turns = 1
  d.input = tokens
  return d
}
/** 设定花费的便捷方式（测试用） */
function setCost(d, cny, tier = 'offpeak') {
  d.byTier[tier].costMicro = Math.round(cny * 1e6)
  return d
}

test('evaluate: 未设预算 → configured false', () => {
  const st = evaluate(dayWith(10), {})
  assert.equal(st.configured, false)
  assert.equal(st.pct, 0)
  assert.equal(st.breached, false)
})

test('evaluate: 只设金额，按金额判定', () => {
  const st = evaluate(dayWith(25), { dailyBudgetCny: 50 })
  assert.equal(st.configured, true)
  assert.equal(st.costPct, 50)
  assert.equal(st.source, 'cost')
  assert.equal(st.breached, false)
})

test('evaluate: 只设 token，按 token 判定', () => {
  const st = evaluate(dayWith(5, 600000), { dailyBudgetTokens: 1000000 })
  assert.equal(st.tokenPct, 60)
  assert.equal(st.source, 'token')
})

test('evaluate: 双轨取 max —— token 先超则按 token 报', () => {
  const st = evaluate(dayWith(10, 900000), { dailyBudgetCny: 50, dailyBudgetTokens: 1000000 })
  assert.equal(st.costPct, 20)
  assert.equal(st.tokenPct, 90)
  assert.equal(st.pct, 90, '★ 应取max')
  assert.equal(st.source, 'token')
})

test('evaluate: 双轨 —— 金额先超则按 cost 报', () => {
  const st = evaluate(dayWith(50, 100000), { dailyBudgetCny: 50, dailyBudgetTokens: 1000000 })
  assert.equal(st.pct, 100)
  assert.equal(st.source, 'cost')
  assert.equal(st.breached, true)
})

test('evaluate: 超限给出剩余额度 0', () => {
  const st = evaluate(dayWith(60), { dailyBudgetCny: 50 })
  assert.equal(st.remainingCny, 0)
})

// ─────────────────────── threshold: 通知去重 ───────────────────────
test('★ checkNotify: 每档每日只提醒一次', () => {
  const d = dayWith(0)
  setCost(d, 50 * 0.25)
  const budget = { dailyBudgetCny: 50, thresholds: [50, 80, 100] }

  assert.equal(checkNotify(d, budget), null, '25% 不触发')

  setCost(d, 50 * 0.55) // 升到 55%
  const first = checkNotify(d, budget)
  assert.ok(first, '55% 应触发')
  assert.equal(first.level, 50)
  assert.equal(first.kind, 'notice')

  setCost(d, 50 * 0.65) // 升到 65%，同一档
  assert.equal(checkNotify(d, budget), null, '★ 65% 同档不应重复提醒')

  setCost(d, 50 * 0.85) // 85%
  const second = checkNotify(d, budget)
  assert.equal(second.level, 80)
  assert.equal(second.kind, 'warn')

  setCost(d, 50 * 1.1) // 110%
  const third = checkNotify(d, budget)
  assert.equal(third.level, 100)
  assert.equal(third.kind, 'over')
  assert.equal(d.overLimit, true)

  setCost(d, 50 * 1.3)
  assert.equal(checkNotify(d, budget), null, '★ 超限后不再重复提醒')
})

test('checkNotify: 跨天后 notified 复位（新账本）', () => {
  const d1 = newDay('2026-10-04')
  setCost(d1, 50 * 0.55)
  assert.ok(checkNotify(d1, { dailyBudgetCny: 50, thresholds: [50] }))
  assert.equal(checkNotify(d1, { dailyBudgetCny: 50, thresholds: [50] }), null)

  const d2 = newDay('2026-10-05') // 新的一天
  setCost(d2, 50 * 0.55)
  assert.ok(checkNotify(d2, { dailyBudgetCny: 50, thresholds: [50] }), '新的一天应重新提醒')
})

test('checkNotify: 未设预算不提醒', () => {
  const d = dayWith(1000)
  assert.equal(checkNotify(d, {}), null)
})

// ─────────────────────── threshold: 账本累加 ───────────────────────
test('addTurn: 累加正确并按 tier 分开', () => {
  const d = newDay('2026-10-04')
  const off = { input: 100, output: 50, cacheRead: 1000, reasoning: 10 }
  addTurn(d, off, { cost: 0.01, tier: 'offpeak' })
  addTurn(d, off, { cost: 0.02, tier: 'peak' })
  addTurn(d, off, { cost: 0.03, tier: 'offpeak' })

  assert.equal(d.turns, 3)
  assert.equal(costOfDay(d), 0.06)
  assert.equal(d.byTier.offpeak.costMicro, 0.04e6)
  assert.equal(d.byTier.offpeak.turns, 2)
  assert.equal(d.byTier.peak.costMicro, 0.02e6)
  assert.equal(d.byTier.peak.turns, 1)
  assert.equal(totalTokens(d), 3 * 1150)
})

test('addTurn: 金额用整数分，无浮点漂移', () => {
  const d = newDay('2026-10-04')
  for (let i = 0; i < 1000; i++) addTurn(d, { input: 1, output: 1, cacheRead: 1 }, { cost: 0.0001, tier: 'offpeak' })
  assert.equal(costOfDay(d), 0.1, '1000×0.0001 应精确为 0.1')
})

test('addTurn: 未知模型归入 unknown 桶', () => {
  const d = newDay('2026-10-04')
  addTurn(d, { input: 1, output: 1, cacheRead: 1, model: 'zzz' }, { cost: 0.01, tier: 'offpeak' })
  assert.ok(d.byModel.zzz)
  assert.equal(d.byModel.zzz.costMicro, 0.01e6)
})

test('★ costOfDay 由 byTier 推导，不会出现总额与分项矛盾', () => {
  const d = newDay('2026-10-04')
  addTurn(d, { input: 100, output: 50, cacheRead: 1000 }, { cost: 0.01, tier: 'offpeak' })
  addTurn(d, { input: 100, output: 50, cacheRead: 1000 }, { cost: 0.02, tier: 'peak' })
  // 即使外部只改 byTier，总额也随之变化
  assert.equal(costOfDay(d), 0.03)
  d.byTier.peak.costMicro = 5_000_000
  assert.equal(costOfDay(d), 5.01, '总额应始终等于分项之和')
  assert.equal(d.byTier.offpeak.costMicro + d.byTier.peak.costMicro, Math.round(costOfDay(d) * 1e6))
})

test('★ checkNotify: 一次冲过多个档位只发最高档，不连弹', () => {
  const d = newDay('2026-10-04')
  d.byTier.peak.costMicro = Math.round(50e6 * 0.94)
  const budget = { dailyBudgetCny: 50, thresholds: [50, 80, 100] }
  const n = checkNotify(d, budget)
  assert.ok(n, '应触发提醒')
  // 94% 未达 100 档，最高可达的是 80
  assert.equal(n.level, 80, '应只返回已达的最高档 80，而非连弹 50 和 80')
  assert.equal(n.kind, 'warn')
  assert.deepEqual(n.skipped, [50], '50 应被合并标记，不单独弹')
  assert.equal(checkNotify(d, budget), null, '之后不再重复')

  // 继续涨到 110%，此时 100 档才触发
  d.byTier.peak.costMicro = Math.round(50e6 * 1.1)
  const n2 = checkNotify(d, budget)
  assert.equal(n2.level, 100)
  assert.equal(n2.kind, 'over')
  assert.equal(d.overLimit, true)
})
