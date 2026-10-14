/**
 * commands.mjs — /budget 命令族
 *
 * 纯函数实现：输入 rawInput + home，输出文本。
 * 不直接依赖 ctx，便于测试与headless 复用。
 */

import {
  today, listDays, summaryOf, readBudget, writeBudget, localDateStr, readDay, writeDay, exportPath,
} from './ledger.mjs'
import {
  evaluate, checkNotify, renderBudget, costOfDay, totalTokens, formatTokens, MICRO, newDay,
} from './threshold.mjs'
import { isPeak, describeOffpeakWait, listPricedModels, getPricingVersion } from './pricing.mjs'
import { analyze, advise } from './attribution.mjs'
import { planStop, executeStop, renderPlan, renderResult } from './guard.mjs'
import { writeFileSync } from 'node:fs'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const now = () => Date.now()

const K = (n) => `${n}k`.replace(/000k$/, (m) => `${parseInt(m, 10) / 1000}M`)

/** 解析 500k / 1.5M / 200000 这样的 token 数 */
function parseTokens(s) {
  if (!s) return null
  const m = String(s).trim().toUpperCase().match(/^([\d.]+)\s*([KM])?$/)
  if (!m) return null
  const v = parseFloat(m[1])
  if (!Number.isFinite(v) || v <= 0) return null
  const mult = m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1
  return Math.round(v * mult)
}

function parseCny(s) {
  if (!s) return null
  const v = parseFloat(String(s).replace(/[¥￥,\s]/g, ''))
  return Number.isFinite(v) && v > 0 ? v : null
}

/** /budget — 查今日 */
export function cmdStatus(home, at = now()) {
  const day = today(home, at)
  const budget = readBudget(home)
  const st = evaluate(day, budget)
  const tier = isPeak(at) ? 'peak' : 'offpeak'

  const extra = {}
  if (st.configured) {
    extra.tier = tier
    extra.waitText = describeOffpeakWait(at)
    if (tier === 'peak') extra.saving = st.cost * 0.5
  }
  return renderBudget(day, budget, extra)
}

/** /budget set [tokens] [cny] */
export function cmdSet(home, raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return '用法:\n  /budget set 50           设每日 ¥50（推荐）\n  /budget set 500k         设每日 50 万 token\n  /budget set 500k 50      两个都设，任一超限即提醒'
  }
  // 允许两种顺序：set 500k 50 或 set 50 500k
  const cny = parts.map(parseCny).find((v) => v !== null) ?? null
  const tok = parts.map(parseTokens).find((v) => v !== null && v > 1e5) ?? null
  const rawCny = parts.find((s) => /^[¥￥]?[\d.]+$/.test(s))
  const rawTok = parts.find((s) => /[KMkm]$/.test(s) || Number(s) > 100000)

  if (!rawCny && !rawTok) {
    return `无法识别参数：${parts.join(' ')}\n用法：/budget set 50  或  /budget set 500k 50`
  }

  const patch = {}
  if (rawCny) {
    const v = parseCny(rawCny)
    if (!v) return '金额需为正数，例如 /budget set 50'
    patch.dailyBudgetCny = v
  }
  if (rawTok) {
    const v = parseTokens(rawTok)
    if (!v) return 'token 数格式不对，例如 /budget set 500k'
    patch.dailyBudgetTokens = v
  }
  const b = writeBudget(home, patch)

  const lines = ['已更新预算：']
  if (b.dailyBudgetCny > 0) lines.push(`  每日 ¥${b.dailyBudgetCny.toFixed(2)}`)
  if (b.dailyBudgetTokens > 0) lines.push(`  每日 ${formatTokens(b.dailyBudgetTokens)} token`)
  lines.push(`  提醒档位 ${b.thresholds.join(' / ')}%`)
  lines.push('')
  lines.push(cmdStatus(home))
  return lines.join('\n')
}

/** /budget threshold 40 75 90 */
export function cmdThreshold(home, raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    const b = readBudget(home)
    return `当前档位：${b.thresholds.join(' / ')}%\n用法：/budget threshold 40 75 90`
  }
  const vals = parts.map((p) => parseFloat(p)).filter((v) => Number.isFinite(v) && v > 0 && v <= 1000)
  if (vals.length === 0) return '档位需为 0~1000 的数字，例如 /budget threshold 40 75 90'
  vals.sort((a, b) => a - b)
  const b = writeBudget(home, { thresholds: vals })
  return `已更新提醒档位：${b.thresholds.join(' / ')}%`
}

/** /budget notify off|quiet|normal */
export function cmdNotify(home, raw) {
  const level = String(raw || '').trim().toLowerCase()
  if (!['off', 'quiet', 'normal'].includes(level)) {
    return '用法：/budget notify off | quiet | normal'
  }
  writeBudget(home, { notifyLevel: level })
  return `提醒级别：${level}`
}

/** /budget history [days] */
export function cmdHistory(home, raw, at = now()) {
  const n = Math.min(30, Math.max(1, parseInt(String(raw || '7').trim(), 10) || 7))
  const days = listDays(home)
  if (days.length === 0) return '暂无历史记录'
  const recent = days.slice(-n)
  const rows = recent.map((d) => summaryOf(home, d))
  const budget = readBudget(home)

  const lines = [`最近 ${rows.length} 天（预算 ${budget.dailyBudgetCny > 0 ? `¥${budget.dailyBudgetCny}/天` : '未设置'}）`, '']
  lines.push('日期          花费      空闲      高峰   token     轮次')
  for (const r of rows) {
    const flag = r.overLimit ? ' !' : ''
    lines.push(
      `${r.date}  ${('¥' + r.cost.toFixed(2)).padStart(7)}  ` +
      `${('¥' + r.offpeak.toFixed(2)).padStart(7)}  ${('¥' + r.peak.toFixed(2)).padStart(7)}  ` +
      `${formatTokens(r.tokens).padStart(7)}  ${String(r.turns).padStart(4)}${flag}`
    )
  }
  const total = rows.reduce((a, r) => a + r.cost, 0)
  const avg = total / rows.length
  lines.push('')
  lines.push(`合计 ¥${total.toFixed(2)} · 日均 ¥${avg.toFixed(2)}`)
  if (budget.dailyBudgetCny > 0) {
    lines.push(`日均 ${((avg / budget.dailyBudgetCny) * 100).toFixed(0)}% 预算 · 超限 ${rows.filter((r) => r.overLimit).length} 天`)
  }
  return lines.join('\n')
}

/** /budget reset[YYYY-MM-DD] — 清空指定日（默认今天）的记账 */
export function cmdReset(home, raw, at = now()) {
  const arg = String(raw || '').trim()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : localDateStr(at)
  if (!listDays(home).includes(date)) return `${date} 没有记账记录，无需重置。`
  writeDay(home, newDay(date))
  return `已重置 ${date} 的记账（预算设置不受影响）。`
}

/** /budget why [日期] — 归因与可行动建议 */
export function cmdWhy(home, raw, at = now()) {
  const arg = String(raw || '').trim()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : localDateStr(at)
  const day = readDay(home, date)
  const label = date === localDateStr(at) ? '今日' : date
  if (day.turns === 0) return `${label}还没有用量记录。`

  const a = analyze(day, readBudget(home))
  const budget = readBudget(home)
  const pct = (v) => `${(v * 100).toFixed(0)}%`

  const lines = [
    `${label} ¥${a.cost.toFixed(2)} · ${a.turns} 轮 · ${formatTokens(a.tokens)} token`,
    '',
    'token 构成（精确值）：',
    `  未缓存输入  ${formatTokens(a.composition.input).padStart(8)}  ${pct(a.uncached.ratio).padStart(4)}  单价最高`,
    `  缓存命中    ${formatTokens(a.composition.cacheRead).padStart(8)}  ${pct(a.cache.hitRatio).padStart(4)}  ${a.cache.label}`,
    `  输出        ${formatTokens(a.composition.output).padStart(8)}`,
    `  其中思维链  ${formatTokens(a.composition.reasoning).padStart(8)}`,
  ]

  lines.push('', '按时段：')
  lines.push(`  空闲        ¥${a.tiers.offpeak.cost.toFixed(2).padStart(7)}  ${pct(a.tiers.offpeak.ratio).padStart(4)}`)
  lines.push(`  高峰        ¥${a.tiers.peak.cost.toFixed(2).padStart(7)}  ${pct(a.tiers.peak.ratio).padStart(4)}`)

  if (a.models.length) {
    lines.push('', '按模型：')
    for (const m of a.models) {
      const share = a.cost > 0 ? m.cost / a.cost : 0
      const flag = m.model === 'unknown' ? ' (未归因)' : ''
      lines.push(`  ${m.model.padEnd(22)} ¥${m.cost.toFixed(2).padStart(7)}  ${pct(share).padStart(4)}  ${String(m.turns).padStart(4)} 轮${flag}`)
    }
  }

  lines.push('', '建议：')
  for (const s of advise(day, a, { now: at, budget })) {
    lines.push(`  · ${s}`)
  }
  return lines.join('\n')
}

/** /budget plan — 预览「关闭所有任务」的影响范围，不执行 */
export function cmdPlan(guard) {
  if (!guard) return '停止功能不可用：未接入 agents 服务。'
  return renderPlan(guard.plan(), guard.alertSummary?.() ?? null)
}

/** /budget stop --all [--dry-run] [--current] */
export async function cmdStop(guard, raw) {
  const arg = String(raw || '').trim()
  const isHelp = arg === '' || /--help|-h/.test(arg)

  // ★ 帮助信息不受能力缺失影响：即使 agents 不可用，
  //   用户也该知道这个命令存在、怎么用、以及为什么用不了。
  if (isHelp) {
    const lines = [
      '关闭所有任务（破坏性操作）',
      '',
      '  /budget plan            预览将停止哪些任务（不执行）',
      '  /budget stop --all --dry-run   预演，不实际停止',
      '  /budget stop --all      停止全部运行中任务',
      '  /budget stop --current  只停当前回合，保留排队工作',
      '',
      '会话日志会保留，之后可用 resume 恢复。',
    ]
    if (!guard) lines.push('', '当前不可用：未接入 agents 服务。')
    return lines.join('\n')
  }

  if (!guard) return '停止功能不可用：未接入 agents 服务。'

  const dryRun = /--dry-run|-n/.test(arg)
  const mode = /--current\b/.test(arg) ? 'currentTurn' : 'everything'
  if (!/--all\b|--current\b|--dry-run|-n/.test(arg)) {
    return '未指定目标。可用：/budget stop --all [--dry-run] 或 /budget stop --current\n先用 /budget plan 预览影响范围。'
  }
  const r = await guard.stop({ mode, dryRun })
  return renderResult(r)
}

/** /budget export [天数] — 导出 JSONL */
export function cmdExport(home, raw) {
  const n = Math.min(365, Math.max(1, parseInt(String(raw || '30').trim(), 10) || 30))
  const days = listDays(home).slice(-n)
  if (days.length === 0) return '暂无记录可导出。'

  const budget = readBudget(home)
  const rows = days.map((d) => {
    const a = analyze(readDay(home, d), budget)
    return JSON.stringify({
      date: d,
      cost: Number(a.cost.toFixed(6)),
      tokens: a.tokens,
      turns: a.turns,
      composition: a.composition,
      cacheHitRatio: Number(a.cache.hitRatio.toFixed(4)),
      uncachedRatio: Number(a.uncached.ratio.toFixed(4)),
      peakCost: Number(a.tiers.peak.cost.toFixed(6)),
      offpeakCost: Number(a.tiers.offpeak.cost.toFixed(6)),
      models: a.models.map((m) => ({ model: m.model, cost: Number(m.cost.toFixed(6)), turns: m.turns })),
      overLimit: !!readDay(home, d).overLimit,
      pricingVersion: a.pricingVersion,
    })
  })

  const target = exportPath(home)
  try {
    writeFileSync(target, rows.join('\n') + '\n', 'utf8')
  } catch (e) {
    return `导出失败：${e.message}`
  }
  return [
    `已导出 ${rows.length} 天到：`,
    `  ${target}`,
    '',
    `每行一天的 JSON，可直接喂给表格工具或自建报表。`,
    `包含 cost / tokens / token 构成 / 缓存命中 / 时段拆分 / 按模型分布。`,
  ].join('\n')
}

/** 命令路由。guard 可选——提供后才有 plan/stop 能力。 */
export function dispatch(home, raw, guard = null) {
  const text = String(raw ?? '').trim()
  const [cmd, ...rest] = text.split(/\s+/)
  const arg = rest.join(' ')
  switch (cmd) {
    case '': case 'status': return cmdStatus(home)
    case 'set': return cmdSet(home, arg)
    case 'threshold': return cmdThreshold(home, arg)
    case 'notify': return cmdNotify(home, arg)
    case 'history': return cmdHistory(home, arg)
    case 'why': return cmdWhy(home, arg)
    case 'reset': return cmdReset(home, arg)
    case 'export': return cmdExport(home, arg)
    case 'plan': return cmdPlan(guard)
    case 'stop': return cmdStop(guard, arg)
    default:
      return helpText(guard)
  }
}

/**
 * 异步命令路由。stop 需要 await agent 静止，必须走这个入口。
 * 其余命令与 dispatch 等价。
 */
export async function dispatchAsync(home, raw, guard = null) {
  const text = String(raw ?? '').trim()
  if (text.split(/\s+/)[0] === 'stop') return cmdStop(guard, text.split(/\s+/).slice(1).join(' '))
  return dispatch(home, raw, guard)
}

function helpText(guard) {
  const lines = [
    'dsh-token-guard · 每日预算',
    '',
    '  /budget                 查今日用量与余量',
    '  /budget set 50          设每日 ¥50（推荐）',
    '  /budget set 500k 50     同时设 token 与金额阈值',
    '  /budget threshold 40 75 90   自定义提醒档位',
    '  /budget notify off|quiet|normal',
    '  /budget history 7       近 7 天明细',
    '  /budget why [日期]      花费归因与可行动建议',
    '  /budget export [天数]   导出 JSONL',
    '  /budget reset [日期]    重置指定日记账',
  ]
  if (guard) {
    lines.push(
      '  /budget plan            预览将停止哪些任务（不执行）',
      '  /budget stop --all      超预算后关闭所有运行中任务',
    )
  } else {
    lines.push('', '（未接入 agents 服务，plan/stop 不可用）')
  }
  return lines.join('\n')
}
