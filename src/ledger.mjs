/**
 * ledger.mjs — 每日账本持久化
 *
 * 设计：
 *  - 惰性日切：读取时比对日期，无定时器，进程跨天/休眠不会漏切
 *  - 每日一个文件，归档不删除
 *  - 写入用「读-改-写」+ 原子替换（临时文件 + rename），避免崩溃留半截文件
 *
 * 账本里只有**已计价**的聚合值，不存原始 usage 记录。
 * 原始记录可从会话日志随时重算，因此账本损坏不致命。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { newDay, addTurn, costOfDay, totalTokens, MICRO } from './threshold.mjs'
import { costOf } from './pricing.mjs'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function localDateStr(ts = Date.now()) {
  const d = new Date(num(ts))
  const p = (n) => String(n).padStart(2, '0')
  // ★ 必须用本地时区，不能用 toISOString()（会转 UTC，跨时区日界会错）
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function ledgerDir(home) { return join(home, 'token-guard') }
export function budgetPath(home) { return join(ledgerDir(home), 'budget.json') }
export function dailyDir(home) { return join(ledgerDir(home), 'daily') }
export function dailyPath(home, date) { return join(dailyDir(home), `${date}.json`) }
export function exportPath(home) { return join(ledgerDir(home), 'export.jsonl') }

function ensureDirs(home) {
  mkdirSync(dailyDir(home), { recursive: true })
}

/** 原子写：先写临时文件再 rename，避免崩溃留半截JSON。 */
function writeAtomic(path, text) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

export function readDay(home, date) {
  const p = dailyPath(home, date)
  if (!existsSync(p)) return newDay(date)
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    // 补齐可能缺失的字段，避免旧版本账本读到undefined
    const base = newDay(date)
    return {
      ...base, ...parsed,
      byTier: { ...base.byTier, ...(parsed.byTier ?? {}) },
      byModel: parsed.byModel ?? {},
      notified: parsed.notified ?? {},
    }
  } catch {
    // 账本损坏：备份后重建，不让插件崩掉
    try { renameSync(p, `${p}.corrupt-${Date.now()}`) } catch {}
    return newDay(date)
  }
}

export function writeDay(home, day) {
  ensureDirs(home)
  writeAtomic(dailyPath(home, day.date), JSON.stringify(day, null, 2))
}

/**
 * 取得「今天」的账本，自动处理日切。
 * 跨天时把旧账本归档（就是留在 daily/ 下，天然归档），新建当天账本。
 */
export function today(home, now = Date.now()) {
  const date = localDateStr(now)
  const day = readDay(home, date)
  if (day.date === date) return day
  return newDay(date)
}

/**
 * 从记录全量重建账本并写盘。
 *
 * ★★ 这里必须是「从零重建」，不是「读旧账本再累加」。
 *   早期实现读旧账本作基底再逐条累加，结果每调用一次就把用量放大一倍
 *   （实测 119 → 238 → 357），因为历史记录会被反复累加。
 *   账本的全部内容都由 records 唯一决定，因此从空账本重建是唯一正确做法：
 *   天然幂等，且能自愈任何损坏与旧格式。
 *
 * ★唯一需要跨调用保留的是 notified（提醒去重标记）——
 *   它不是 usage 推导出来的，属于用户状态，因此从旧账本继承。
 *
 * @param {object[]} records 采集到的全部 usage 记录（时间升序）
 * @returns {{days:string[], last:object|null, written:number}}
 */
export function ingest(home, records, { save = true } = {}) {
  ensureDirs(home)
  const days = new Map()// date -> 全新账本
  const notifiedFrom = new Map() // date -> 旧账本的 notified

  for (const r of records) {
    const date = localDateStr(r.time)
    let day = days.get(date)
    if (!day) {
      //继承提醒去重标记（用户状态，非usage 派生）
      const prev = readDay(home, date)
      day = newDay(date)
      day.notified = { ...(prev.notified ?? {}) }
      day.overLimit = !!prev.overLimit
      notifiedFrom.set(date, { ...day.notified })
      days.set(date, day)
    }
    addTurn(day, r, costOf(r, r.model, r.time))
  }

  // 无变化的日期跳过写盘：原子写要建临时文件 + rename，实测每文件约 3ms。
  // session 事件每轮都会触发采集，跳过无变化写入能把热路径压到接近零。
  let written = 0
  if (save) {
    for (const [date, day] of days) {
      const prevNotified = notifiedFrom.get(date)
      const notifiedChanged =
        JSON.stringify(day.notified) !== JSON.stringify(prevNotified)
      if (day.turns === 0 && !notifiedChanged) continue
      writeDay(home, day)
      written++
    }
  }

  const list = [...days.keys()].sort()
  const last = list.length ? days.get(list[list.length - 1]) : null
  return { days: list, last, written }
}

/** 列出有账本的日期，升序。 */
export function listDays(home) {
  try {
    return readdirSync(dailyDir(home))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
  } catch { return [] }
}

/** 读回历史某天的聚合值（用于 /budget history）。 */
export function summaryOf(home, date) {
  const d = readDay(home, date)
  return {
    date: d.date,
    cost: costOfDay(d),
    tokens: totalTokens(d),
    turns: d.turns,
    peak: num(d.byTier?.peak?.costMicro) / MICRO,
    offpeak: num(d.byTier?.offpeak?.costMicro) / MICRO,
    overLimit: !!d.overLimit,
  }
}

// ──────────────────────────预算配置 ──────────────────────────

export const DEFAULT_BUDGET = {
  dailyBudgetCny: 0,// 0 = 未设置
  dailyBudgetTokens: 0,
  thresholds: [50, 80, 100],
  notifyLevel: 'normal',   // off | quiet | normal
  createdAt: null,
  updatedAt: null,
}

export function readBudget(home) {
  const p = budgetPath(home)
  if (!existsSync(p)) return { ...DEFAULT_BUDGET }
  try {
    return { ...DEFAULT_BUDGET, ...JSON.parse(readFileSync(p, 'utf8')) }
  } catch { return { ...DEFAULT_BUDGET } }
}

export function writeBudget(home, patch) {
  ensureDirs(home)
  const next = { ...readBudget(home), ...patch, updatedAt: Date.now() }
  writeAtomic(budgetPath(home), JSON.stringify(next, null, 2))
  return next
}
