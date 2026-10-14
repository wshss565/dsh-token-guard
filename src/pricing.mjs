/**
 * pricing.mjs — DeepSeek 双时段计价
 *
 * 计价口径（已用本机真实数据验证）：
 *   cost = (cacheRead×hit + input×miss + output×out) ×时段系数 / 1e6
 *
 * ★ 关键：inputTokens 是净新增输入，不含缓存命中部分。
 *   合并计价或只按 input 计价会严重低估成本。
 *
 * 时段（DeepSeek 官方规则，内部固定 UTC+8）：
 *   高峰：工作日 9:00-12:00、14:00-18:00
 *   空闲：其余全部时间，单价减半
 *
 * 注：计价表为 2026-09 官方价，随官方调整可能变化。
 *     请通过 setPricingVersion() 更新并同步 COST-MODEL.md。
 */

const PEAK_HOURS = [[9, 12], [14, 18]] // 北京时间，半开区间 [start, end)
const BEIJING_OFFSET_MS = 8 * 3600_000

/** 单位：元 / 百万 token（高峰时段价格） */
const DEFAULT_PRICING = {
  'deepseek-v4-pro':    { hit: 0.30, miss: 9,  out: 27 },
  'deepseek-v4-flash':  { hit: 0.04, miss: 2,  out: 8  },
  'deepseek-flash':     { hit: 0.04, miss: 2,  out: 8  },
}
const FALLBACK_MODEL = 'deepseek-v4-pro'

let PRICING = { ...DEFAULT_PRICING }
let PRICING_VERSION = '2026-09'

export function setPricingTable(table, version) {
  if (table) PRICING = { ...table }
  if (version) PRICING_VERSION = version
}
export function getPricingVersion() { return PRICING_VERSION }
export function listPricedModels() { return Object.keys(PRICING) }

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * 判断某时刻是否为高峰时段。
 *
 * ⚠️ 内部固定按 UTC+8 判定，**故意不读系统时区**。
 *    用 Date 本地方法会随用户时区漂移，导致高峰判定错误。
 *    时区设置不应影响本函数结果（见 pricing.test.mjs）。
 */
export function isPeak(ts) {
  const b = new Date(num(ts) + BEIJING_OFFSET_MS)
  const dow = b.getUTCDay()
  if (dow === 0 || dow === 6) return false // 周末全天空闲
  const h = b.getUTCHours()
  return PEAK_HOURS.some(([s, e]) => h >= s && h < e)
}

export function tierOf(ts) {
  return isPeak(ts) ? 'peak' : 'offpeak'
}

/**
 * 距下一个空闲时段还有多久（毫秒）。已在空闲则返回 0。
 * 用于「等 N 小时就半价」的行动建议。
 *
 * 峰谷结构（北京时间）：
 *   工作日  [0,9)闲 [9,12)峰 [12,14)闲 [14,18)峰 [18,24)闲
 *   周末    全天闲
 * 因此从任一高峰时段出发，下一个空闲起点必在当天 12:00 或 18:00。
 */
export function msUntilOffpeak(ts) {
  if (!isPeak(ts)) return 0
  const bj = new Date(num(ts) + BEIJING_OFFSET_MS)
  const hour = bj.getUTCHours() + bj.getUTCMinutes() / 60 + bj.getUTCSeconds() / 3600
  const targetHour = hour < 12 ? 12 : 18
  return Math.round((targetHour - hour) * 3600_000)
}

/** 人类可读的「距空闲时段」文案。 */
export function describeOffpeakWait(ts) {
  if (!isPeak(ts)) return '当前已是空闲时段'
  const ms = msUntilOffpeak(ts)
  const h = Math.floor(ms / 3600_000)
  const m = Math.round((ms % 3600_000) / 60_000)
  const at = hourOf(ts) < 12 ? '12:00' : '18:00'
  if (h === 0) return `距 ${at} 空闲时段还有 ${m} 分钟`
  return `距 ${at} 空闲时段还有 ${h} 小时 ${m} 分`
}

function hourOf(ts) {
  return new Date(num(ts) + BEIJING_OFFSET_MS).getUTCHours()
}

/**
 * 计算一轮请求的成本。
 * @param {{input:number,output:number,cacheRead:number,cacheWrite:number}} r
 * @param {string} model
 * @param {number} ts 毫秒时间戳
 */
export function costOf(r, model, ts) {
  const m = model || FALLBACK_MODEL
  const base = PRICING[m] ?? PRICING[FALLBACK_MODEL]
  const estimatedPrice = !(m in PRICING)
  const k = isPeak(ts) ? 1 : 0.5

  const unit = { hit: base.hit * k, miss: base.miss * k, out: base.out * k }
  const cost =
    (num(r.cacheRead) * unit.hit +
     num(r.input) * unit.miss +
     num(r.output) * unit.out) / 1e6

  return {
    cost,
    tier: k === 1 ? 'peak' : 'offpeak',
    unit,
    model: m,
    estimatedPrice,
    pricingVersion: PRICING_VERSION,
  }
}

/**
 * 估算「若在空闲时段执行同一轮可省多少」。
 * 空闲时段系数固定 0.5，所以节省 = 成本 × 50%。
 */
export function savingsIfOffpeak(priced) {
  return priced.tier === 'peak' ? priced.cost * 0.5 : 0
}

/** 按整数分累加，避免浮点漂移。日累计量级 ¥0.01~¥100。 */
export function toCents(cny) { return Math.round(num(cny) * 100) }
export function fromCents(cents) { return (num(cents) / 100).toFixed(2) }
