/**
 * threshold.mjs — 金额 / token 双轨阈值判定
 *
 * 设计要点：
 *  1. 金额与 token 是「或」关系，任一超限即触发，取 Math.max 判定
 *  2. 每档每日只提醒一次（notified 去重）—— 不去重会导致每轮刷屏，
 *     用户会立刻关掉通知，功能永久失效
 *  3. 超限不阻断，只记账。用户全权决定何时停
 *  4. 金额用整数分累加，避免浮点漂移
 */

/**
 * 一天的账本初始状态。
 *
 * ★ 金额用「微元」（1e-6 元）整数累加，而非「分」。
 *   原因：单轮成本常低于 1 分（flash 空闲期一轮约 ¥0.0001~0.01），
 *   用分累加会把这些抹成 0，导致系统性低估。
 *   微元最小单位 1e-6 元，远低于任何有意义的金额，且全程整数无浮点误差。
 */
export const MICRO = 1_000_000

export function newDay(dateStr) {
  return {
    date: dateStr,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    // ★ 金额只存byTier，总额由 costOfDay() 推导，不另存总量字段
    byTier: {
      peak:    { costMicro: 0, turns: 0, tokens: 0 },
      offpeak: { costMicro: 0, turns: 0, tokens: 0 },
    },
    byModel: {},
    turns: 0,
    notified: {},
    overLimit: false,
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const toMicro = (cny) => Math.round(num(cny) * MICRO)

/** 累加一轮。r 需含 input/output/cacheRead/reasoning，priced 来自 pricing.costOf。 */
export function addTurn(day, r, priced) {
  const input = num(r.input), output = num(r.output)
  const cacheRead = num(r.cacheRead), cacheWrite = num(r.cacheWrite)
  const micro = toMicro(priced.cost)

  day.input += input
  day.output += output
  day.cacheRead += cacheRead
  day.cacheWrite += cacheWrite
  day.reasoning += num(r.reasoning)
  day.turns++

  const tier = (day.byTier[priced.tier] ??= { costMicro: 0, turns: 0, tokens: 0 })
  tier.costMicro += micro
  tier.turns++
  tier.tokens += input + output + cacheRead

  const m = (day.byModel[r.model ?? 'unknown'] ??= { costMicro: 0, turns: 0, input: 0, output: 0, cacheRead: 0 })
  m.costMicro += micro
  m.turns++
  m.input += input; m.output += output; m.cacheRead += cacheRead

  return day
}

export function totalTokens(day) {
  return num(day.input) + num(day.output) + num(day.cacheRead) + num(day.cacheWrite)
}

/**
 * 当日总花费。
 *
 * ★ 始终由 byTier 推导，不读独立的 costMicro 字段。
 *   原因：总量与分时段拆分若各自独立存储，账本被外部修改或部分写入时
 *   会产生「总额 ¥47 但分项只有 ¥3.47」这类自相矛盾。
 *   单一数据源从结构上杜绝不一致。
 */
export function costOfDay(day) {
  const t = day.byTier ?? {}
  return (num(t.peak?.costMicro) + num(t.offpeak?.costMicro)) / MICRO
}

/**
 * 阈值判定。
 * @param day 账本
 * @param budget { dailyBudgetCny, dailyBudgetTokens, thresholds }
 */
export function evaluate(day, budget = {}) {
  const cny = num(budget.dailyBudgetCny)
  const tok = num(budget.dailyBudgetTokens)
  const cost = costOfDay(day)
  const tokens = totalTokens(day)

  // 两个阈值都为 0/null → 未设置预算，不触发
  const hasCost = cny > 0
  const hasToken = tok > 0
  if (!hasCost && !hasToken) {
    return { configured: false, costPct: 0, tokenPct: 0, pct: 0, breached: false, source: null, cost, tokens }
  }

  const costPct = hasCost ? (cost / cny) * 100 : 0
  const tokenPct = hasToken ? (tokens / tok) * 100 : 0

  // ★ 取 max：任一维度超限都要提醒
  const pct = Math.max(costPct, tokenPct)
  const source = !hasToken ? 'cost' : !hasCost ? 'token' : (costPct >= tokenPct ? 'cost' : 'token')

  return {
    configured: true,
    costPct, tokenPct, pct,
    breached: pct >= 100,
    source,
    cost, tokens,
    remainingCny: hasCost ? Math.max(0, cny - cost) : null,
    remainingTokens: hasToken ? Math.max(0, tok - tokens) : null,
  }
}

/**
 * 检查是否有新档位需要提醒。**每档每日只返回一次。**
 *
 * ★ 只返回**最高**的待触发档位，并把所有 ≤ 该档位的档位一并标记为已通知。
 *   否则当用量一次性冲过50%/80% 时，会在同一次调用里连弹三条提醒。
 *   用户看到的是「已用 94%」这一条，而不是被三条历史档位轰炸。
 *
 * @returns {{level:number, kind:string, skipped:number[]}|null}
 */
export function checkNotify(day, budget = {}) {
  const st = evaluate(day, budget)
  if (!st.configured) return null

  const levels = [...(budget.thresholds ?? [50, 80, 100])]
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
  const notified = (day.notified ??= {})

  // 找出所有已达到但未通知的档位
  const pending = levels.filter((lv) => !notified[String(lv)] && st.pct >= lv)
  if (pending.length === 0) return null

  const level = pending[pending.length - 1]      // 取最高档
  for (const lv of pending) notified[String(lv)] = Date.now()   // 全部标记

  if (st.breached) day.overLimit = true
  return {
    level,
    kind: level >= 100 ? 'over' : level >= 80 ? 'warn' : 'notice',
    skipped: pending.slice(0, -1),              // 被合并的更低档（供日志，不打扰用户）
    status: st,
  }
}

/** 档位文案。强调「可行动建议」而非仅给数字。 */
export function renderBudget(day, budget, extra = {}) {
  const st = evaluate(day, budget)
  if (!st.configured) {
    return [
      '尚未设置预算',
      '',
      '  /budget set 50           设每日 ¥50（推荐）',
      '  /budget set 500k         设每日 50 万 token',
      '  /budget set 500k 50      两个都设，任一超限即提醒',
    ].join('\n')
  }

  const lines = []
  const cur = extra.tier === 'peak' ? '高峰时段' : '空闲时段'
  const bar = progressBar(st.pct)

  lines.push(`今日 ¥${st.cost.toFixed(2)}${budget.dailyBudgetCny > 0 ? ` / ¥${num(budget.dailyBudgetCny).toFixed(2)}` : ''}`
    + `${budget.dailyBudgetTokens > 0 ? `  ·  ${formatTokens(st.tokens)} / ${formatTokens(num(budget.dailyBudgetTokens))}` : ''}`)
  lines.push(`${bar}  ${st.pct.toFixed(0)}%  ·  ${cur}`)

  const t = day.byTier ?? {}
  const peak = num(t.peak?.costMicro) / MICRO
  const off = num(t.offpeak?.costMicro) / MICRO
  if (day.turns > 0) {
    lines.push(`  其中 空闲 ¥${off.toFixed(2)} · 高峰 ¥${peak.toFixed(2)}`)
  }

  if (extra.waitText) {
    lines.push(`  ${extra.waitText}`)
    if (extra.saving > 0) lines.push(`  同一批任务改到空闲时段可省约 ¥${extra.saving.toFixed(2)}`)
  }

  if (st.breached) {
    lines.push('')
    lines.push(`  已超限 ${st.source === 'cost' ? `¥${(st.cost - num(budget.dailyBudgetCny)).toFixed(2)}` : `${formatTokens(st.tokens - num(budget.dailyBudgetTokens))}`}`)
    lines.push(`  记账继续，可/ budget history 7 查看趋势`)
  }
  return lines.join('\n')
}

function progressBar(pct, width = 24) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']'
}

export function formatTokens(n) {
  const v = num(n)
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(Math.round(v))
}
