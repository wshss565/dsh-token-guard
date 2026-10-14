/**
 * guard.mjs — 超预算时的「关闭所有任务」防护
 *
 * ⚠️ 这是破坏性操作。本模块的设计原则：
 *   1. **永不自动执行**。只提供「计划」与「执行」两个显式入口。
 *   2. 执行前必须能预览影响范围（plan 先于execute）。
 *   3. 逐个报告结果，不做「全成功/全失败」的笼统结论。
 *
 * ── 已核实的 dsh 停止契约（源码级）─────────────────────────
 *   Agent.cancel(cause, options?) 是**唯一公开 stop 原语**。
 *     - cause: { kind: 'user' } | { kind: 'parent' }  ←封闭联合
 *     - options.keepInbox: true  只停当前回合，保留排队与 steering
 *     - options.keepInbox: false （默认）清空队列 + 中止当前回合
 *     - 对 idle agent 是 no-op，不会「卡死」下一条prompt
 *     - 取消是协作式的：只await 边界前后检查，忽略 signal 的工作会先落定
 *   公开 abort() 不存在。
 *
 *   AgentHandle.dispose() 只对**创建者**开放。插件通过 ctx.agents
 *   拿到的是裸 Agent，属于「注册表观察者」，**不能dispose**。
 *   → 因此「关闭所有任务」只能用 cancel()。
 *
 * ── 诚实的局限 ────────────────────────────────────────────
 *   1. **没有 plugin 专属的 cause**。联合类型只有 user / parent。
 *      预算插件触发取消时只能用 'user'——这在语义上是借用，
 *      宿主无法区分「用户点的」和「预算插件触发的」。
 *   2. **session-backed 子 agent 应由宿主拒绝**（host 的 session.cancel
 *      对其返回 agent-busy）。插件直连 ctx.agents 拿不到这个守卫，
 *      因此本模块对无法确认归属的 agent 一律标记为 skipped 而非强停。
 *   3. **取消是协作式的**，返回不代表工作已停。需 await whenIdle()。
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 停止模式 */
export const MODE = {
  /** 只停当前回合，保留排队工作（对应 keepInbox: true） */
  currentTurn: { keepInbox: true, label: '仅停止当前回合' },
  /** 放弃当前与全部排队工作（对应 keepInbox: false） */
  everything: { keepInbox: false, label: '关闭全部任务' },
}

/**
 * 判断 agent 是否为可安全停止的根 agent。
 *
 * 宿主对 session-backed 子 agent 的停止请求会返回 agent-busy，
 * 因为它们的生命周期归父级所有。插件无法直接查询归属关系，
 * 因此采取保守策略：无法确认为根 agent 的一律跳过。
 */
function classify(agent) {
  const id = agent?.id ?? agent?.session?.id ?? null
  if (!id) return { id: null, ok: false, reason: '无法确定 agent 标识' }

  // 显式的父级标记：文档中 AgentOptions.setParentAgent 会设置
  const parent = agent?.parentAgent ?? agent?.options?.parentAgent ?? null
  if (parent) {
    return { id, ok: false, reason: '子 agent 由父级管理，宿主会拒绝（agent-busy）', subagent: true }
  }

  if (typeof agent.cancel !== 'function') {
    return { id, ok: false, reason: '该 agent 不支持 cancel()' }
  }

  return { id, ok: true, reason: null, subagent: false, agent }
}

/** 读取 agent 状态（不同版本字段名可能不同，尽力而为） */
function statusOf(agent) {
  const s = agent?.status
  if (typeof s === 'string') return s
  if (s && typeof s === 'object') return s.kind ?? s.phase ?? 'unknown'
  return 'unknown'
}

/**
 * 生成停止计划（预览）。**不执行任何操作。**
 *
 * @param {object} ctx插件上下文，用于取 ctx.agents
 * @returns {{ok:boolean, agents:object[], summary:object, reason?:string}}
 */
export function planStop(ctx) {
  const agents = ctx?.get?.('agents')
  if (!agents || typeof agents.list !== 'function') {
    return {
      ok: false,
      agents: [],
      summary: { total: 0, stoppable: 0, skipped: 0, running: 0 },
      reason: 'agents 服务不可用，无法枚举运行中的任务',
    }
  }

  let list = []
  try { list = agents.list() ?? [] } catch (e) {
    return {
      ok: false, agents: [],
      summary: { total: 0, stoppable: 0, skipped: 0, running: 0 },
      reason: `枚举 agent 失败：${e.message}`,
    }
  }

  const rows = list.map((a) => {
    const c = classify(a)
    const status = statusOf(a)
    return {
      id: c.id,
      status,
      // idle 的 agent 取消是 no-op，标出来让用户知道「这个本来就没在跑」
      idle: status === 'idle',
      stoppable: c.ok,
      skipped: !c.ok,
      reason: c.reason,
    }
  })

  return {
    ok: true,
    agents: rows,
    summary: {
      total: rows.length,
      // stoppable 含idle：它「可调用」但实际是 no-op。
      // running 单独统计，供文案区分「有多少真在跑」。
      stoppable: rows.filter((r) => r.stoppable).length,
      skipped: rows.filter((r) => r.skipped).length,
      running: rows.filter((r) => r.status === 'running').length,
      idle: rows.filter((r) => r.idle).length,
    },
  }
}

/**
 * 执行停止。
 *
 * ⚠️ 破坏性操作。调用方必须已通过 planStop 向用户展示影响范围。
 *
 * @param {object} ctx
 * @param {object} opts
 * @param {'currentTurn'|'everything'} opts.mode  停止模式
 * @param {boolean} opts.dryRun               true 时只报告不执行
 * @param {number}  opts.timeoutMs            等待静止的上限
 * @returns {Promise<object>} 逐个 agent 的结果
 */
export async function executeStop(ctx, opts = {}) {
  const { mode = 'everything', dryRun = false, timeoutMs = 3000 } = opts
  const conf = MODE[mode] ?? MODE.everything
  const plan = planStop(ctx)

  if (!plan.ok) {
    return { ok: false, error: plan.reason, results: [], plan }
  }
  if (plan.summary.stoppable === 0) {
    return {
      ok: true,
      plan,
      results: [],
      message: plan.summary.total === 0
        ? '当前没有运行中的任务。'
        : `有 ${plan.summary.total} 个任务，但没有一个可安全停止（子 agent 由父级管理）。`,
    }
  }

  if (dryRun) {
    const runnable = plan.agents.filter((a) => a.stoppable && !a.idle).length
    return {
      ok: true, dryRun: true, plan,
      message: `将停止 ${runnable} 个运行中任务（${conf.label}）`
        + (plan.summary.skipped ? `，跳过 ${plan.summary.skipped} 个子 agent` : '')
        + `${plan.summary.idle ? `，${plan.summary.idle} 个空闲不动` : ''}。未执行任何操作。`,
      results: [],
    }
  }

  const agents = ctx.get('agents')
  const results = []
  const cause = { kind: 'user' }   // ★ 联合类型只有 user/parent，见文件头说明

  for (const row of plan.agents) {
    if (!row.stoppable) {
      // ★ skipped 不是 failure。子 agent 由父级管理是正常情况，
      //   把它算作「失败」会让用户以为出了错。
      results.push({ id: row.id, ok: true, skipped: true, reason: row.reason })
      continue
    }
    // idle 的 agent 跳过：cancel 对它是 no-op，没必要走一趟
    if (row.idle) {
      results.push({ id: row.id, ok: true, noop: true, reason: '该 agent 已是空闲，无需停止' })
      continue
    }

    let agent
    try { agent = agents.get(row.id) } catch (e) {
      results.push({ id: row.id, ok: false, reason: `获取 agent 失败：${e.message}` })
      continue
    }
    if (!agent || typeof agent.cancel !== 'function') {
      results.push({ id: row.id, ok: false, reason: 'agent 不可用或不支持 cancel()' })
      continue
    }

    try {
      agent.cancel(cause, { keepInbox: conf.keepInbox })
      results.push({ id: row.id, ok: true })
    } catch (e) {
      results.push({ id: row.id, ok: false, reason: e.message })
    }
  }

  // 取消是协作式的：请求已发出不代表工作已停。
  // 等待静止，但设上限避免无限挂起。
  const waited = await waitIdle(agents, plan, timeoutMs)

  const stopped = results.filter((r) => r.ok && !r.noop && !r.skipped).length
  const failed = results.filter((r) => !r.ok).length
  const noop = results.filter((r) => r.noop).length
  const skipped = results.filter((r) => r.skipped).length

  return {
    ok: failed === 0,
    plan,
    results,
    waited,
    mode,
    keepInbox: conf.keepInbox,
    summary: { stopped, failed, noop, skipped },
  }
}

/** 等待 agent 落定。超时返回 false，不抛错。 */
async function waitIdle(agents, plan, timeoutMs) {
  const targets = plan.agents.filter((r) => r.stoppable && !r.idle)
  if (targets.length === 0) return true

  const tasks = targets.map((r) => {
    try {
      const a = agents.get(r.id)
      return typeof a?.whenIdle === 'function' ? a.whenIdle() : Promise.resolve()
    } catch { return Promise.resolve() }
  })

  // 全�� Promise.allSettled，任一超时不影响其他
  const timer = new Promise((res) => setTimeout(() => res(false), timeoutMs))
  const all = Promise.allSettled(tasks).then(() => true)
  try { return await Promise.race([all, timer]) } catch { return false }
}

/** 渲染停止计划为可读文本。 */
export function renderPlan(plan, alert) {
  if (!plan.ok) return `无法生成停止计划：${plan.reason}`
  const s = plan.summary
  const lines = [
    `当前 ${s.total} 个 agent：${s.running} 个运行中，${s.idle} 个空闲`,
  ]
  // running 与 stoppable 口径不同：子 agent 也在跑，但不由我们停。
  // 不说清楚会让用户困惑「说2 个运行，怎么只停1 个」。
  if (s.skipped > 0) {
    lines.push(`其中 ${s.skipped} 个是子 agent（由父级管理，宿主会拒绝停止）`)
  }
  for (const a of plan.agents) {
    const mark = a.skipped ? '×' : a.idle ? '·' : '○'
    const note = a.reason ?? (a.idle ? '空闲，无需停止' : '可停止')
    lines.push(`  ${mark} ${String(a.id).slice(0, 44).padEnd(44)} ${String(a.status).padEnd(10)} ${note}`)
  }
  if (alert) {
    lines.push('')
    lines.push(`触发原因：今日已用 ¥${alert.cost} / ¥${alert.budget}（${alert.pct}%）`)
  }
  lines.push('')
  const runnable = s.running - plan.agents.filter((a) => a.skipped && !a.idle).length
  lines.push(s.stoppable === 0
    ? '没有可安全停止的任务。可在设置里查看详情。'
    : `执行 /budget stop --all 将停止 ${runnable} 个运行中任务`
      + (s.skipped ? `，跳过 ${s.skipped} 个子 agent` : '')
      + `${s.idle ? `，${s.idle} 个空闲不动` : ''}。`)
  return lines.join('\n')
}

/** 渲染执行结果。 */
export function renderResult(r) {
  if (r.dryRun) return `预演：${r.message}`
  if (!r.ok && r.error) return `停止失败：${r.error}`
  if (r.message) return r.message

  const s = r.summary
  const lines = [`已停止 ${s.stopped} 个任务（${MODE[r.mode]?.label ?? r.mode}）`]
  if (s.noop) lines.push(`  ${s.noop} 个已是空闲，未操作`)
  if (s.skipped) lines.push(`  ${s.skipped} 个子 agent 跳过（由父级管理，非错误）`)
  if (s.failed) lines.push(`  ${s.failed} 个失败`)
  if (!r.waited) {
    lines.push('')
    lines.push('注意：取消是协作式的，部分任务可能仍在收尾。')
    lines.push('稍等片刻再用 /budget plan 复查。')
  }
  for (const x of r.results.filter((y) => !y.ok)) {
    lines.push(`  × ${x.id}: ${x.reason}`)
  }
  lines.push('')
  lines.push('会话日志已保留，之后可用 resume 恢复。')
  return lines.join('\n')
}
