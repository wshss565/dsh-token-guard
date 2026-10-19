import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  localDateStr, readDay, writeDay, ingest, listDays, summaryOf,
  readBudget, writeBudget, dailyPath,
} from '../src/ledger.mjs'
import { costOfDay, totalTokens, newDay } from '../src/threshold.mjs'
import { decodeZstdFrames, normalizeMessage } from '../src/collector.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'tg-'))
// bj(y, m, d, h, min) → 「北京时间某时刻」对应的 Unix 毫秒。
//
// ★ 必须与 pricing.mjs 的时段口径一致：时段固定 UTC+8
//   （DeepSeek 官方规则，见 pricing.mjs 文件头说明）。
//   因此这里用 Date.UTC(y, m-1, d, h-8, min)换算——
//   减8 再按 UTC 解释，结果就是「北京时间 h 点」。
//
//   曾改成 new Date(y, m-1, d, h, min)（跟随机器本地时区），
//   本地 UTC+8 跑得过，但 CI 的 ubuntu runner 是 UTC 时，
//   时段判定与测试期望对不上，且与产品语义矛盾。
//
//   localDateStr() 跟随本地时区是对的——「预算日界」按用户当地零点算；
//   但「时段」由官方规则固定，不跟随机器时区。两者语义不同，别混用。
const bj = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 8, min)

function rec(time, over = {}) {
  return {
    time, seq: 1, input: 1000, output: 500, cacheRead: 20000,
    cacheWrite: 0, reasoning: 100, reportedTotal: 21500, total: 21500,
    model: 'deepseek-flash', ...over,
  }
}

// ─────────────────────────── 日界 ───────────────────────────
//
// ★ localDateStr 跟随**运行机器的本地时区**（预算日界按用户当地零点算），
//   而 bj() 构造的是**北京时间**（与 pricing.mjs 的时段口径一致）。
//   两者语义不同 —— 用 bj() 测localDateStr 会在非UTC+8 环境下偏一天。
//   （实际发生：CI 的 ubuntu runner 是 UTC，
//     「跨月与跨年」断言实得 2026-09-30、期望 2026-10-01。）
//
//   所以本节一律用 local(y, m, d, h, min) 构造本地时刻。
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime()

test('localDateStr: 用本地时区，不用 UTC', () => {
  // 断言重点是「不走 toISOString」——若实现误用 UTC，
  // 同一个时刻会被推到前一天或后一天。
  //
  // 选当地时间 10:00：这个钟点在 UTC-12 ~ UTC+14 的所有时区里
  // 都落在同一个日历日，因此断言与运行环境时区无关。
  // （若改成 Date.UTC(2026, 9, 5, 0, 0) 这种「跨日敏感」的时刻，
  //   在 UTC 与 UTC+8 下会给出不同日期，无法同时通过。）
  assert.equal(localDateStr(local(2026, 10, 5, 10, 0)), '2026-10-05')

  // 再验一次「本地午夜」——这才是预算日界的语义
  assert.equal(localDateStr(local(2026, 10, 5, 0, 0)), '2026-10-05')
})

test('localDateStr: 跨月与跨年', () => {
  assert.equal(localDateStr(local(2026, 10, 1, 0, 0)), '2026-10-01')
  assert.equal(localDateStr(local(2026, 1, 1, 0, 0)), '2026-01-01')
})
test('localDateStr: 23:59:59.999 与次日 00:00 分属两天', () => {
  // 月份参数从 0 开始：9 = 10月，10 = 11月
  const a = new Date(2026, 9, 30, 23, 59, 59, 999).getTime()   // 2026-10-30
  const b = new Date(2026, 9, 31, 0, 0, 0, 0).getTime()// 2026-10-31
  assert.equal(localDateStr(a), '2026-10-30')
  assert.equal(localDateStr(b), '2026-10-31')
  assert.notEqual(localDateStr(a), localDateStr(b))
})

test('localDateStr: 跨年边界', () => {
  const a = new Date(2026, 11, 31, 23, 59, 59, 999).getTime()  // 2026-12-31
  const b = new Date(2027, 0, 1, 0, 0, 0, 0).getTime()           // 2027-01-01
  assert.equal(localDateStr(a), '2026-12-31')
  assert.equal(localDateStr(b), '2027-01-01')
})

// ─────────────────────── 账本读写 ───────────────────────
test('readDay: 文件不存在时返回空账本', () => {
  const home = tmp()
  const d = readDay(home, '2026-10-04')
  assert.equal(d.turns, 0)
  assert.equal(d.date, '2026-10-04')
  assert.equal(costOfDay(d), 0)
  rmSync(home, { recursive: true, force: true })
})

test('writeDay + readDay: 往返一致', () => {
  const home = tmp()
  const d = newDay('2026-10-04')
  d.turns = 5
  d.byTier.offpeak.costMicro = 1_500_000
  writeDay(home, d)
  const r = readDay(home, '2026-10-04')
  assert.equal(r.turns, 5)
  assert.equal(costOfDay(r), 1.5)
  rmSync(home, { recursive: true, force: true })
})

test('readDay: 损坏文件不抛错，备份后重建', () => {
  const home = tmp()
  mkdirSync(join(home, 'token-guard', 'daily'), { recursive: true })
  writeFileSync(dailyPath(home, '2026-10-04'), '{ this is not json', 'utf8')
  const d = readDay(home, '2026-10-04')
  assert.equal(d.turns, 0, '应回退到空账本')
  rmSync(home, { recursive: true, force: true })
})

test('readDay: 旧版账本缺字段时补齐，不返回 undefined', () => {
  const home = tmp()
  mkdirSync(join(home, 'token-guard', 'daily'), { recursive: true })
  writeFileSync(dailyPath(home, '2026-10-04'), JSON.stringify({ turns: 3 }), 'utf8')
  const d = readDay(home, '2026-10-04')
  assert.equal(d.turns, 3)
  assert.ok(d.byTier.peak && d.byTier.offpeak)
  assert.ok(d.byModel && d.notified)
  assert.equal(costOfDay(d), 0)
  rmSync(home, { recursive: true, force: true })
})

// ─────────────────────── 摄取 ───────────────────────
test('★ ingest: 数据必须真正落盘（曾因写盘时重读而清空）', () => {
  const home = tmp()
  const { days, last } = ingest(home, [rec(bj(2026, 10, 3, 14))])
  assert.deepEqual(days, ['2026-10-03'])
  assert.equal(last.turns, 1)
  assert.ok(costOfDay(last) > 0, '内存账本应有花费')

  // 关键：从磁盘重新读，必须有数据
  const fromDisk = readDay(home, '2026-10-03')
  assert.equal(fromDisk.turns, 1, '★ 落盘后轮次不应为 0')
  assert.ok(costOfDay(fromDisk) > 0, '★ 落盘后花费不应为 0')
  rmSync(home, { recursive: true, force: true })
})

test('ingest: 跨日期自动切分并归档', () => {
  const home = tmp()
  const records = [
    rec(bj(2026, 9, 8, 14), { seq: 1 }),
    rec(bj(2026, 9, 8, 15), { seq: 2 }),
    rec(bj(2026, 9, 12, 14), { seq: 3 }),
    rec(bj(2026, 10, 3, 14), { seq: 4 }),
  ]
  const { days } = ingest(home, records)
  assert.deepEqual(days, ['2026-09-08', '2026-09-12', '2026-10-03'])
  assert.deepEqual(listDays(home), ['2026-09-08', '2026-09-12', '2026-10-03'])
  assert.equal(readDay(home, '2026-09-08').turns, 2)
  assert.equal(readDay(home, '2026-09-12').turns, 1)
  assert.equal(readDay(home, '2026-10-03').turns, 1)
  rmSync(home, { recursive: true, force: true })
})

test('ingest: 乱序输入也能正确切分', () => {
  const home = tmp()
  // 先给 10-03，再给 09-08（模拟时钟回拨或文件顺序不定）
  const { days } = ingest(home, [
    rec(bj(2026, 10, 3, 14), { seq: 2 }),
    rec(bj(2026, 9, 8, 14), { seq: 1 }),
  ])
  assert.deepEqual([...days].sort(), ['2026-09-08', '2026-10-03'])
  assert.equal(readDay(home, '2026-09-08').turns, 1)
  assert.equal(readDay(home, '2026-10-03').turns, 1)
  rmSync(home, { recursive: true, force: true })
})

test('★ ingest: 重复摄取同一批记录是幂等的（不累加）', () => {
  const home = tmp()
  const r = [rec(bj(2026, 10, 3, 14))]
  ingest(home, r)
  const c1 = costOfDay(readDay(home, '2026-10-03'))
  const t1 = readDay(home, '2026-10-03').turns

  ingest(home, r)
  const c2 = costOfDay(readDay(home, '2026-10-03'))
  const t2 = readDay(home, '2026-10-03').turns

  // 账本内容完全由 records 决定，重复摄取必须得到相同结果。
  // 早期实现读旧账本再累加，导致用量成倍膨胀（119→238→357），必须防回归。
  assert.equal(t2, t1, '★ 重复摄取不应增加轮次')
  assert.equal(c2, c1, '★ 重复摄取不应改变花费')
  assert.equal(t1, 1)
  rmSync(home, { recursive: true, force: true })
})

test('ingest: 三次重复摄取后账本稳定', () => {
  const home = tmp()
  const r = [rec(bj(2026, 10, 3, 14)), rec(bj(2026, 10, 3, 15), { seq: 2 })]
  const snaps = []
  for (let i = 0; i < 3; i++) {
    ingest(home, r)
    const d = readDay(home, '2026-10-03')
    snaps.push(`${d.turns}:${costOfDay(d)}`)
  }
  assert.equal(new Set(snaps).size, 1, `三次结果应一致，实得 ${snaps.join(' / ')}`)
  rmSync(home, { recursive: true, force: true })
})

test('ingest: notified 标记跨调用保留', () => {
  const home = tmp()
  const r = [rec(bj(2026, 10, 3, 14))]
  ingest(home, r)

  // 模拟提醒已触发
  const day = readDay(home, '2026-10-03')
  day.notified = { '50': Date.now() }
  day.overLimit = true
  writeDay(home, day)

  // 重新摄取（相当于重启后再次采集）
  ingest(home, r)
  const after = readDay(home, '2026-10-03')
  assert.ok(after.notified['50'], '★ 提醒去重标记必须保留，否则会重复提醒')
  assert.equal(after.overLimit, true, '超限标记应保留')
  assert.equal(after.turns, 1, '轮次仍应为 1，不受 notified 影响')
  rmSync(home, { recursive: true, force: true })
})

test('ingest: 空数组不报错也不清空已有账本', () => {
  const home = tmp()
  const r = [rec(bj(2026, 10, 3, 14))]
  ingest(home, r)
  ingest(home, [])
  assert.equal(readDay(home, '2026-10-03').turns, 1, '空摄取不应清空账本')
  rmSync(home, { recursive: true, force: true })
})

test('ingest: 空数组不报错', () => {
  const home = tmp()
  const { days, last } = ingest(home, [])
  assert.deepEqual(days, [])
  assert.equal(last, null)
  rmSync(home, { recursive: true, force: true })
})

test('summaryOf: 汇总字段齐备', () => {
  const home = tmp()
  ingest(home, [rec(bj(2026, 10, 3, 14))])
  const s = summaryOf(home, '2026-10-03')
  assert.equal(s.date, '2026-10-03')
  assert.equal(s.turns, 1)
  assert.equal(s.tokens, 21500)
  assert.ok(s.cost > 0)
  rmSync(home, { recursive: true, force: true })
})

// ─────────────────────── 预算配置 ───────────────────────
test('readBudget: 未设置时返回默认值', () => {
  const home = tmp()
  const b = readBudget(home)
  assert.equal(b.dailyBudgetCny, 0)
  assert.equal(b.dailyBudgetTokens, 0)
  assert.deepEqual(b.thresholds, [50, 80, 100])
  rmSync(home, { recursive: true, force: true })
})

test('writeBudget: 局部更新不影响其他字段', () => {
  const home = tmp()
  writeBudget(home, { dailyBudgetCny: 50 })
  writeBudget(home, { thresholds: [40, 90] })
  const b = readBudget(home)
  assert.equal(b.dailyBudgetCny, 50, '未提及的字段应保留')
  assert.deepEqual(b.thresholds, [40, 90])
  rmSync(home, { recursive: true, force: true })
})

// ─────────────────────── collector ───────────────────────
test('normalizeMessage: 无 usage 返回 null（不抛错）', () => {
  assert.equal(normalizeMessage({ type: 'assistant/message', data: {} }), null)
  assert.equal(normalizeMessage({ type: 'other' }), null)
  assert.equal(normalizeMessage(null), null)
})

test('normalizeMessage: 缺失字段按 0 处理', () => {
  const r = normalizeMessage({ time: 100, seq: 1, data: { usage: { inputTokens: 5 } } })
  assert.equal(r.input, 5)
  assert.equal(r.output, 0)
  assert.equal(r.cacheRead, 0)
  assert.equal(r.reasoning, 0)
  assert.equal(r.total, 5, 'total 应由三段推导，不依赖 reportedTotal')
})

test('normalizeMessage: total = input+output+cacheRead', () => {
  const r = normalizeMessage({
    time: 1, seq: 1,
    data: { usage: { inputTokens: 814, outputTokens: 154, cacheReadTokens: 8320, totalTokens: 9288 } },
  })
  assert.equal(r.total, 814 + 154 + 8320)
  assert.equal(r.total, r.reportedTotal, '真实样本中两者应一致')
})

test('decodeZstdFrames: 非 zstd 数据不抛错', () => {
  assert.doesNotThrow(() => decodeZstdFrames(Buffer.from('not zstd at all')))
})
