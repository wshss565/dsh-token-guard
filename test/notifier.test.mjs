import assert from 'node:assert/strict'
import { test } from 'node:test'

import { shouldNotify, normalizeLevel, buildAlert, titleOf, LEVELS } from '../src/notifier.mjs'
import { newDay } from '../src/threshold.mjs'

const bj = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 8, min)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function dayAt(cny, tier = 'offpeak') {
  const d = newDay('2026-10-04')
  d.byTier[tier].costMicro = Math.round(cny * 1e6)
  d.byTier[tier].turns = 1
  d.turns = 1
  d.input = 1000
  return d
}

// ─────────────────────── 通知级别 ───────────────────────
test('shouldNotify: off 全部关闭', () => {
  for (const k of ['notice', 'warn', 'over']) {
    assert.equal(shouldNotify(k, 'off'), false, `${k} 在 off 下不应提醒`)
  }
})
test('shouldNotify: quiet 只在超限时提醒', () => {
  assert.equal(shouldNotify('notice', 'quiet'), false)
  assert.equal(shouldNotify('warn', 'quiet'), false)
  assert.equal(shouldNotify('over', 'quiet'), true)
})
test('shouldNotify: normal 全部提醒', () => {
  for (const k of ['notice', 'warn', 'over']) {
    assert.equal(shouldNotify(k, 'normal'), true)
  }
})
test('normalizeLevel: 非法值回落 normal', () => {
  assert.equal(normalizeLevel('off'), 'off')
  assert.equal(normalizeLevel('quiet'), 'quiet')
  assert.equal(normalizeLevel('bogus'), 'normal')
  assert.equal(normalizeLevel(undefined), 'normal')
})

// ─────────────────────── 标题 ───────────────────────
test('titleOf: 按类型给标题', () => {
  assert.equal(titleOf('over'), '已超每日预算')
  assert.equal(titleOf('warn'), '接近每日预算')
  assert.equal(titleOf('notice'), '预算提醒')
})

// ─────────────────────── 提醒负载 ───────────────────────
test('buildAlert: 未设预算时 configured false', () => {
  const a = buildAlert({ day: dayAt(1), budget: {}, at: bj(2026, 10, 3, 13) })
  assert.equal(a.configured, false)
  assert.equal(a.kind, 'idle')
  assert.match(a.text, /尚未设置预算/)
  assert.equal(a.shouldNotify, false, '未设预算不该提醒')
})

test('buildAlert: 空闲时段无 saving 提示', () => {
  const a = buildAlert({
    day: dayAt(25), budget: { dailyBudgetCny: 50, notifyLevel: 'normal' },
    at: bj(2026, 10, 3, 13),          // 周六 → 空闲
  })
  assert.equal(a.tier, 'offpeak')
  assert.equal(a.saving, 0, '空闲时段不应给切换省的钱')
  assert.match(a.text, /当前已是空闲时段/)
})

test('buildAlert: 高峰时段给可行动建议', () => {
  const a = buildAlert({
    day: dayAt(47), budget: { dailyBudgetCny: 50, notifyLevel: 'normal' },
    at: bj(2026, 10, 5, 17, 20),      // 周一 17:20 → 高峰
  })
  assert.equal(a.tier, 'peak')
  assert.ok(a.saving > 0, '高峰应提示切换时段可省')
  assert.ok(Math.abs(a.saving - 47 * 0.5) < 0.01)
  assert.match(a.text, /18:00/, '应提示距 18:00 空闲还有多久')
})

test('buildAlert: 带 hit 时用 hit 的类型与档位', () => {
  const a = buildAlert({
    day: dayAt(51),
    budget: { dailyBudgetCny: 50, notifyLevel: 'normal' },
    hit: { level: 100, kind: 'over', status: { cost: 51, pct: 102, tokens: 100, source: 'cost', configured: true, breached: true } },
    at: bj(2026, 10, 3, 13),
  })
  assert.equal(a.kind, 'over')
  assert.equal(a.level, 100)
  assert.equal(a.title, '已超每日预算')
  assert.equal(a.shouldNotify, true)
  assert.equal(a.pct, 102)
})

test('buildAlert: quiet 级别下超限仍提醒', () => {
  const mk = (level) => buildAlert({
    day: dayAt(51),
    budget: { dailyBudgetCny: 50, notifyLevel: 'quiet' },
    hit: { level, kind: level >= 100 ? 'over' : level >= 80 ? 'warn' : 'notice', status: { cost: 51, pct: 102, tokens: 1, source: 'cost', configured: true } },
  })
  assert.equal(mk(100).shouldNotify, true, 'quiet 下超限应提醒')
  assert.equal(mk(80).shouldNotify, false, 'quiet 下警告不提醒')
  assert.equal(mk(50).shouldNotify, false, 'quiet 下普通提醒不提醒')
})

test('buildAlert: stamp 用于客户端去重', () => {
  const at = Date.now()
  const a = buildAlert({ day: dayAt(1), budget: { dailyBudgetCny: 50 }, at })
  assert.equal(a.stamp, at, 'stamp 应等于传入时间，便于客户端比对')
})

test('buildAlert: overLimit 状态透传', () => {
  const d = dayAt(51)
  d.overLimit = true
  const a = buildAlert({ day: d, budget: { dailyBudgetCny: 50, notifyLevel: 'normal' } })
  assert.equal(a.overLimit, true)
})

test('LEVELS: 三个级别定义完整', () => {
  assert.deepEqual(Object.keys(LEVELS).sort(), ['normal', 'off', 'quiet'])
  assert.equal(LEVELS.off.rank, 0)
  assert.equal(LEVELS.quiet.rank, 1)
  assert.equal(LEVELS.normal.rank, 2)
})
