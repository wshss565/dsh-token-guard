/**
 * attribution.mjs — 花费归因
 *
 * ★ 诚实的口径声明（必须写进 README 与 UI）：
 *   dsh 的 usage **不按 source 拆分输入 token**。usage 里只有
 *   inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens
 *   五个总数，没有「其中多少来自工具 Schema、多少来自历史消息」。
 *
 *   因此：
 *     - reasoning 是**精确值**（来自 usage.reasoningTokens）
 *     - 按模型 / 按时段 / 按缓存命中 / 按 token 构成 —— 这些也都是**精确**的
 *     - 传统五分类（system/tools/history/reasoning/tool-result）中的其余四类
 *       只能靠字符数**估算**，本模块不做这种估算
 *
 *   原因：估算出来的数字会被用户当作事实，得出错误结论的成本代价比没有数字更高。
 *   本模块只给精确聚合，不给无法验证的拆分。
 *
 * 真正可行动的信息是「哪种结构导致花钱多」：
 *   未缓存输入占比高 → 频繁切模型 / 改工具 Schema，KV 缓存失效
 *   高峰时段占比高   → 移到空闲时段可省一半
 *   某模型占比过高   → 换更便宜的模型
 * 这三条都能从精确数据推出，所以本模块聚焦于此。
 */

import { costOfDay, totalTokens, MICRO, formatTokens } from './threshold.mjs'
import { isPeak, getPricingVersion } from './pricing.mjs'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 缓存命中率区间与含义 */
const CACHE_BANDS = [
  { min: 0.9,  level: 'good', label: '优秀', advice: '缓存保持良好，继续保持。' },
  { min: 0.7,  level: 'ok',   label: '正常', advice: '命中率正常。' },
  { min: 0.4,  level: 'warn', label: '偏低', advice: '命中率偏低。频繁切换模型或中途修改工具 Schema 会清空 KV 缓存，成本可差数倍。' },
  { min: 0,    level: 'bad',  label: '很差', advice: '缓存命中很差。若同一会话内反复切换模型，缓存每次都会失效，建议固定模型或分会话。' },
]

export function cacheBand(ratio) {
  return CACHE_BANDS.find((b) => ratio >= b.min) ?? CACHE_BANDS[CACHE_BANDS.length - 1]
}

/**
 * 未缓存输入占比 —— 最关键的单一指标。
 * 这部分单价最高（flash 空闲 ¥1/百万，v4-pro 高峰 ¥9/百万）。
 */
export function uncachedRatio(day) {
  const tot = totalTokens(day)
  return tot > 0 ? num(day.input) / tot : 0
}

/**
 * 生成结构化归因。
 * 所有字段均来自精确数据，不含估算。
 */
export function analyze(day, budget = {}) {
  const cost = costOfDay(day)
  const tokens = totalTokens(day)
  const tiers = day.byTier ?? {}
  const peakCost = num(tiers.peak?.costMicro) / MICRO
  const offCost = num(tiers.offpeak?.costMicro) / MICRO
  const models = Object.entries(day.byModel ?? {})
    .map(([model, v]) => ({
      model,
      cost: num(v.costMicro) / MICRO,
      turns: num(v.turns),
      input: num(v.input),
      output: num(v.output),
      cacheRead: num(v.cacheRead),
    }))
    .sort((a, b) => b.cost - a.cost)

  const cr = tokens > 0 ? day.cacheRead / tokens : 0
  const un = uncachedRatio(day)

  return {
    date: day.date,
    turns: num(day.turns),
    cost,
    tokens,
    // 精确：token 构成
    composition: {
      input: num(day.input),
      output: num(day.output),
      cacheRead: num(day.cacheRead),
      cacheWrite: num(day.cacheWrite),
      reasoning: num(day.reasoning),
      reasoningIsExact: true,
    },
    cache: {
      hitRatio: cr,
      band: cacheBand(cr).level,
      label: cacheBand(cr).label,
    },
    uncached: {
      tokens: num(day.input),
      ratio: un,
    },
    tiers: {
      peak: { cost: peakCost, ratio: cost > 0 ? peakCost / cost : 0 },
      offpeak: { cost: offCost, ratio: cost > 0 ? offCost / cost : 0 },
    },
    models,
    pricingVersion: getPricingVersion(),
  }
}

/**
 * 生成可行动建议。
 * 每条都附带「依据的数字」——没有数字的建议是空话。
 */
export function advise(day, analysis, { now = Date.now(), budget = {} } = {}) {
  const out = []
  const a = analysis
  if (a.turns === 0 || a.cost === 0) return ['用量结构正常，无需调整。']

  // 1. 未缓存输入占比 —— 最高优先级
  if (a.uncached.ratio > 0.2) {
    out.push(
      `未缓存输入 ${formatTokens(a.uncached.tokens)}，占总输入 ${(a.uncached.ratio * 100).toFixed(0)}%。`
      + `这部分单价最高（flash 空闲 ¥1/百万，v4-pro 高峰 ¥9/百万）。`
      + `${a.cache.label === '正常' || a.cache.label === '优秀' ? '' : '建议固定模型、避免中途改工具 Schema。'}`,
    )
  }

  // 2. 缓存命中
  if (a.cache.hitRatio < 0.7) {
    out.push(`缓存命中 ${(a.cache.hitRatio * 100).toFixed(0)}%（${a.cache.label}）。${cacheBand(a.cache.hitRatio).advice}`)
  }

  // 3. 时段 —— 只在高峰占比高时提
  if (a.tiers.peak.ratio > 0.3 && a.tiers.peak.cost > 0) {
    const save = a.tiers.peak.cost * 0.5
    const wait = describeWait(now)
    out.push(
      `¥${a.tiers.peak.cost.toFixed(2)} 花在高峰时段（占 ${(a.tiers.peak.ratio * 100).toFixed(0)}%）。`
      + `同批任务移到空闲时段约可省 ¥${save.toFixed(2)}。${wait}`,
    )
  } else if (a.tiers.peak.cost === 0 && a.tiers.offpeak.cost > 0) {
    out.push('全部用量都在空闲时段，已享受半价。')
  }

  // 4. 模型集中度 —— 只对已知模型提建议
  const known = a.models.filter((m) => m.model !== 'unknown')
  const unknown = a.models.find((m) => m.model === 'unknown')
  const top = known[0]
  if (known.length > 1 && top && top.cost / a.cost > 0.6) {
    out.push(`${(top.cost / a.cost * 100).toFixed(0)}% 花在 ${top.model}。若任务可降级到更便宜的模型，效果直接。`)
  } else if (known.length === 1 && top && a.cost > 0) {
    out.push(`全部用量来自 ${top.model}。`)
  }
  if (unknown && unknown.cost / a.cost > 0.3) {
    out.push(
      `${(unknown.cost / a.cost * 100).toFixed(0)}% 的用量未归到具体模型`
      + `（该会话未记录 model/selection 事件），这部分归因仅供参考。`,
    )
  }

  // 5. 预算视角
  if (budget.dailyBudgetCny > 0 && a.cost / budget.dailyBudgetCny > 0.8) {
    out.push(`已用预算的 ${(a.cost / budget.dailyBudgetCny * 100).toFixed(0)}%。`)
  }

  return out.length ? out : ['用量结构正常，无需调整。']
}

function describeWait(now) {
  // 避免循环依赖，这里内联一个简化版
  if (!isPeak(now)) return '当前已是空闲时段。'
  const b = new Date(num(now) + 8 * 3600_000)
  const h = b.getUTCHours() + b.getUTCMinutes() / 60
  const at = h < 12 ? '12:00' : '18:00'
  const hrs = h < 12 ? 12 - h : 18 - h
  return `距 ${at} 空闲时段还有 ${Math.floor(hrs)} 小时 ${Math.round((hrs % 1) * 60)} 分。`
}
