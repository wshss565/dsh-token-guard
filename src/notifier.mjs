/**
 * notifier.mjs — 提醒判定与文案
 *
 * ★ 关键限制（已核实，非推测）：
 *   dsh 没有「UI 通知」API。官方文档与社区插件教程均未提供
 *   notification / notice 服务。已确认存在的服务只有：
 *     webServer / commands / systemPrompt / tools / agents / sessionPersistence / logger
 *
 *   因此后台事件无法直接向会话推消息：
 *     - agent.inject() 会进模型上下文（会消耗 token，且模型会看到提醒）→ 不适合
 *     - commands.register 的 text 只在用户主动输入斜杠命令时渲染 → 不能主动推
 *     - webServer.register 只返回 HTTP，需客户端自行渲染
 *
 * 本插件的应对：
 *   1. 账本是唯一事实来源，客户端随时可查（不依赖推送）
 *   2. 宿主暴露 HTTP 接口，客户端轮询；命中阈值时用浏览器 Notification 提醒
 *   3. 提醒文案由本模块统一生成，客户端只负责展示 —— 保证多端文案一致
 *
 * 参考：社区插件 dsh-plugin-notify 走的也是「客户端 slot + 浏览器通知」路线。
 */

import { evaluate, renderBudget } from './threshold.mjs'
import { isPeak, describeOffpeakWait } from './pricing.mjs'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 通知级别。quiet 表示只在超限时提醒，避免打扰。 */
export const LEVELS = {
  off:    { rank: 0, label: '关闭' },
  quiet:  { rank: 1, label: '仅超限提醒' },
  normal: { rank: 2, label: '全部提醒' },
}

export function normalizeLevel(v) {
  return Object.hasOwn(LEVELS, v) ? v : 'normal'
}

/** 该通知级别下，此提醒类型是否应推送。 */
export function shouldNotify(kind, notifyLevel) {
  const lv = LEVELS[normalizeLevel(notifyLevel)]
  if (lv.rank === 0) return false
  if (lv.rank >= 2) return true
  return kind === 'over' // quiet 只在超限时提醒
}

/** 提醒类型 → 标题。 */
export function titleOf(kind) {
  if (kind === 'over') return '已超每日预算'
  if (kind === 'warn') return '接近每日预算'
  return '预算提醒'
}

/**
 * 生成提醒负载。客户端直接渲染这份数据，不自己算账 —— 保证多端一致。
 *
 * @param {object}  p
 * @param {object}  p.day     当日账本
 * @param {object}  p.budget  预算配置
 * @param {object?} p.hit     checkNotify() 的返回值；无则只做状态查询
 * @param {number}  p.at      当前时间戳
 */
export function buildAlert({ day, budget, hit = null, at = Date.now() }) {
  const st = hit?.status ?? evaluate(day, budget)
  // ★ kind 由实际百分比决定，不能只看 breached。
  //   否则 84%（已越过80% 警告档）会被判成 idle，warn 分支永远进不去，
  //   「查看有哪些任务在跑」的入口也就不会出现。
  const kind = hit?.kind
    ?? (st.breached ? 'over' : num(st.pct) >= 80 ? 'warn' : 'idle')
  const tier = isPeak(at) ? 'peak' : 'offpeak'
  // 高峰时提示「现在做能省一半」。仅在已设预算且确有花费时给。
  const saving = tier === 'peak' && st.configured ? num(st.cost) * 0.5 : 0

  return {
    version: 1,
    kind,
    level: hit?.level ?? null,
    title: kind === 'idle' ? '预算状态' : titleOf(kind),
    text: renderBudget(day, budget, {
      tier,
      waitText: describeOffpeakWait(at),
      saving,
    }),
    // ★ 超限时的处置建议。不自动执行——由用户决定。
    //   客户端据此渲染「关闭所有任务」按钮。
    remediation: buildRemediation(kind, st, { at }),
    date: day.date,
    cost: Number(num(st.cost).toFixed(4)),
    tokens: num(st.tokens),
    pct: Number(num(st.pct).toFixed(1)),
    source: st.source,
    configured: st.configured,
    tier,
    saving,                 // ★ 客户端可据此提示「省 ¥X」
    overLimit: !!day.overLimit,
    // ★ 未设预算一律不提醒。没预算就弹通知等于骚扰用户。
    shouldNotify: st.configured && shouldNotify(kind, budget?.notifyLevel),
    stamp: at,               // 客户端据此判断是否已提醒过
  }
}

/**
 * 处置建议。
 * 排序按「省钱确定性」：改时段最确定（立刻省一半），停止任务最不确定
 * （可能中断有价值的工作），所以放最后并明确提示先预览。
 */
function buildRemediation(kind, st, { at }) {
  const items = []
  const tier = isPeak(at) ? 'peak' : 'offpeak'

  // ★ 等空闲时段排在最前：这是唯一「不用牺牲任何东西」的省钱方式。
  //   停止任务可能毁掉有价值的工作，应该作为最后手段而非首选。
  if (tier === 'peak' && num(st.cost) > 0) {
    const wait = describeOffpeakWait(at)
    const at12 = hourOfDay(at) < 12
    items.push({
      id: 'wait-offpeak',
      label: at12 ? '等到 12:00 进入空闲时段' : '等到 18:00 进入空闲时段',
      hint: wait === '当前已是空闲时段'
        ? '当前已是空闲时段'
        : `${wait.replace(/^距\s*/, '')}，同批任务约可省 ¥${(num(st.cost) * 0.5).toFixed(2)}`,
      action: null,
      destructive: false,
      order: -1,
    })
  }

  if (st.breached) {
    items.push({
      id: 'stop-all',
      label: '关闭所有运行中任务',
      hint: '破坏性操作，建议先预览',
      // ★ 分两步：先预览影响范围，再显式执行。
      //   execute 给出完整 query 而非裸 confirm 字段——避免调用方
      //   拼出 `?true=true` 这类歧义 URL。
      planFirst: true,
      action: { method: 'GET', path: '/api/token-guard/plan' },
      execute: {
        method: 'GET',
        path: '/api/token-guard/stop?confirm=true&dryRun=false&mode=everything',
      },
      destructive: true,
      order: 10,
    })
  } else if (kind === 'warn') {
    items.push({
      id: 'plan',
      label: '查看有哪些任务在跑',
      hint: '不执行任何操作',
      action: { method: 'GET', path: '/api/token-guard/plan' },
      destructive: false,
      order: 5,
    })
  }

  return items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

function hourOfDay(ts) {
  return new Date(num(ts) + 8 * 3600_000).getUTCHours()
}
