/**
 * 客户端面板 — 预算余量环 + 关闭任务 + 浏览器通知
 *
 * 装配协议（已核实）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory 接收 require，返回 { inject, apply }
 *   ctx.slots.inject(槽位, () => ctx.slots.register({...}, 组件))
 *
 * ★ 关于「关闭所有任务」按钮的三条硬规则：
 *   1. **必须先预览**。按钮不直接执行，先调/plan 展示影响范围。
 *   2. **必须二次确认**。用户在预览面板上明确点「确认关闭」才动手。
 *   3. **失败不静默**。任一环节出错都把原因显示出来。
 *   理由：这是破坏性操作，可能毁掉有价值的长时间任务。
 */

const API = '/api/token-guard'

// jsx-runtime 的坑：第三个参数是 key，不是 children。
// 用统一包装把 children 塞进 props，否则界面空白且难排查。
const e = (type, props, ...children) => {
  const p = props || {}
  if (children.length === 0) return h(type, p)
  if (children.length === 1) return h(type, { ...p, children: children[0] })
  return hs(type, { ...p, children })
}

let h, hs, React, ui

const CACHE_KEY = 'token-guard'

/** 上一次提醒的 stamp，用于去重 */
const seen = new Map()

// ── 颜色 ──────────────────────────────────────────────────
const C = {
  ok: '#1f9e75',
  warn: '#d29922',
  alert: '#ba7517',
  over: '#f85149',
  dim: '#8b949e',
  faint: '#6e7681',
  border: 'var(--color-border-tertiary, rgba(128,128,128,0.25))',
  fg: 'var(--color-text-primary, inherit)',
}

function colorOf(pct, overLimit) {
  if (overLimit) return C.over
  if (pct >= 100) return C.over
  if (pct >= 80) return C.alert
  if (pct >= 50) return C.warn
  return C.ok
}

// ── 网络 ──────────────────────────────────────────────────
async function jget(path) {
  const res = await fetch(`${API}${path}`, { cache: 'no-store' })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`)
    err.status = res.status
    err.body = body
    throw err
  }
  return body
}

const fetchAlert = () => jget('/alert').catch(() => null)
const fetchPlan = () => jget('/plan')

/** 真正执行停止。必须由用户在预览面板上明确确认。 */
async function doStop(mode = 'everything') {
  return jget(`/stop?confirm=true&dryRun=false&mode=${mode}`)
}

/** 浏览器通知。被拦截时静默降级，不影响面板显示。 */
function notify(alert) {
  if (!alert?.shouldNotify) return
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  try {
    new Notification(alert.title, { body: alert.text, tag: `token-guard-${alert.date}-${alert.level}` })
  } catch { /* 某些平台会抛，忽略 */ }
}

async function poll(notifyEnabled) {
  const alert = await fetchAlert()
  if (!alert) return null
  if (notifyEnabled && alert.stamp) {
    const key = `${alert.date}:${alert.level ?? 'idle'}`
    if (seen.get(key) !== alert.stamp) {
      seen.set(key, alert.stamp)
      notify(alert)
    }
    for (const k of seen.keys()) if (!k.startsWith(alert.date)) seen.delete(k)
  }
  return alert
}

// ── 组件 ──────────────────────────────────────────────────
function Ring({ pct, color, size = 34 }) {
  const r = size / 2 - 3
  const c = 2 * Math.PI * r
  const filled = Math.max(0, Math.min(1, pct / 100))
  return e('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, style: { flexShrink: 0 } },
    e('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'rgba(128,128,128,0.2)', strokeWidth: 3 }),
    e('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color, strokeWidth: 3,
      strokeDasharray: `${c * filled} ${c}`, strokeLinecap: 'round',
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    }),
  )
}

/** 停止确认面板 —— 展示 plan，必须显式点确认才执行 */
function StopConfirm({ plan, onCancel, onDone }) {
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const s = plan?.summary ?? {}

  const run = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await doStop()
      onDone?.(r)
    } catch (x) {
      setErr(x.message || String(x))
    } finally {
      setBusy(false)
    }
  }

  const rows = (plan?.agents ?? []).map((a) => {
    const mark = a.skipped ? '×' : a.idle ? '·' : '○'
    const color = a.skipped ? C.dim : a.idle ? C.faint : C.over
    return e('div', {
      key: a.id,
      style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, lineHeight: 1.9 },
    },
      e('span', { style: { color, width: 10, flexShrink: 0 } }, mark),
      e('span', {
        style: {
          fontFamily: 'var(--font-mono, monospace)', flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      }, a.id),
      e('span', { style: { color: C.faint, fontSize: 11, flexShrink: 0 } }, a.reason ?? a.status),
    )
  })

  return e('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
    e('div', { style: { fontSize: 12.5, lineHeight: 1.6 } },
      `将停止 ${s.running - (plan?.agents ?? []).filter((a) => a.skipped && !a.idle).length} 个运行中任务`,
      s.skipped ? `，跳过 ${s.skipped} 个子 agent` : '',
      s.idle ? `，${s.idle} 个空闲不动` : '。',
    ),
    rows.length ? e('div', {
      style: {
        maxHeight: 140, overflow: 'auto', padding: 8,
        background: 'rgba(128,128,128,0.07)', borderRadius: 6,
      },
    }, rows) : null,
    e('div', { style: { fontSize: 11.5, color: C.dim, lineHeight: 1.6 } },
      '会清空排队中尚未执行的任务。会话日志会保留，之后可用 resume 恢复。'),
    err ? e('div', { style: { fontSize: 11.5, color: C.over } }, `失败：${err}`) : null,
    e('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      e('button', {
        onClick: onCancel, disabled: busy,
        style: btn(false, false),
      }, '取消'),
      e('button', {
        onClick: run, disabled: busy || !s.stoppable,
        style: btn(true, busy || !s.stoppable),
      }, busy ? '正在关闭…' : '确认关闭全部'),
    ),
  )
}

function btn(primary, disabled) {
  return {
    fontSize: 12,
    padding: '5px 12px',
    borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    border: `1px solid ${primary ? C.over : C.border}`,
    background: primary ? C.over : 'transparent',
    color: primary ? '#fff' : C.fg,
  }
}

function BudgetPanel(props) {
  const [alert, setAlert] = React.useState(props.alert ?? null)
  const [notifyOn, setNotifyOn] = React.useState(
    () => localStorage.getItem(`${CACHE_KEY}:notify`) === '1')
  const [plan, setPlan] = React.useState(null)
  const [planErr, setPlanErr] = React.useState(null)
  const [loadingPlan, setLoadingPlan] = React.useState(false)
  const [result, setResult] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    const tick = async () => {
      const a = await poll(notifyOn)
      if (alive && a) setAlert(a)
    }
    tick()
    const timer = setInterval(tick, 30_000)
    return () => { alive = false; clearInterval(timer) }
  }, [notifyOn])

  const toggleNotify = async (v) => {
    setNotifyOn(v)
    localStorage.setItem(`${CACHE_KEY}:notify`, v ? '1' : '0')
    if (!v) return
    if (typeof Notification === 'undefined') return
    const p = await Notification.requestPermission()
    if (p !== 'granted') setPlanErr('通知权限被拒绝，面板仍会显示预算状态')
  }

  const openPlan = async () => {
    setLoadingPlan(true); setPlanErr(null); setResult(null)
    try {
      const r = await fetchPlan()
      if (!r.ok) { setPlanErr(r.error || '无法获取任务列表'); return }
      setPlan(r.plan)
    } catch (x) {
      setPlanErr(x.message || String(x))
    } finally {
      setLoadingPlan(false)
    }
  }

  if (!alert) {
    return e('div', { style: { padding: 12, fontSize: 13, opacity: 0.6 } }, '正在读取预算…')
  }

  if (!alert.configured) {
    return e('div', { style: { padding: 12, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 } },
      e('div', null, '尚未设置预算'),
      e('div', { style: { opacity: 0.7, fontFamily: 'var(--font-mono, monospace)' } }, '/budget set 50'),
    )
  }

  const color = colorOf(alert.pct, alert.overLimit)
  const remediation = alert.remediation ?? []
  const stopItem = remediation.find((r) => r.id === 'stop-all')
  const others = remediation.filter((r) => r.id !== 'stop-all' && r.action !== null)

  return e('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 10 } },
    // 头部：余量环 + 数字
    e('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      e(Ring, { pct: alert.pct, color }),
      e('div', { style: { flex: 1, minWidth: 0 } },
        e('div', { style: { fontSize: 14, fontWeight: 500 } },
          `¥${alert.cost.toFixed(2)}`,
          e('span', { style: { opacity: 0.6, fontSize: 12 } }, `  ${alert.pct}%`)),
        e('div', { style: { fontSize: 12, opacity: 0.7 } },
          alert.tier === 'peak' ? '高峰时段' : '空闲时段'),
      ),
      e('button', { onClick: openPlan, style: btn(false, loadingPlan) },
        loadingPlan ? '读取中…' : '任务'),
    ),

    // 停止确认面板
    plan ? e('div', {
      style: {
        padding: 10, borderRadius: 8,
        border: `1px solid ${C.over}`,
        background: 'rgba(248,81,73,0.06)',
      },
    }, e(StopConfirm, {
      plan,
      onCancel: () => { setPlan(null); setPlanErr(null) },
      onDone: (r) => { setPlan(null); setResult(r) },
    })) : null,

    // 执行结果
    result ? e('div', {
      style: {
        padding: 10, borderRadius: 8, fontSize: 12, lineHeight: 1.7,
        border: `1px solid ${result.ok ? C.ok : C.warn}`,
        background: result.ok ? 'rgba(31,158,117,0.07)' : 'rgba(210,153,34,0.07)',
      },
    },
      e('div', { style: { fontWeight: 500, marginBottom: 4 } },
        `已停止 ${result.summary?.stopped ?? 0} 个任务`),
      result.summary?.noop ? e('div', { style: { color: C.dim } }, `${result.summary.noop} 个已是空闲`) : null,
      result.summary?.skipped ? e('div', { style: { color: C.dim } }, `${result.summary.skipped} 个子 agent 跳过`) : null,
      result.summary?.failed ? e('div', { style: { color: C.over } }, `${result.summary.failed} 个失败`) : null,
      !result.waited ? e('div', { style: { color: C.warn, marginTop: 4 } },
        '取消是协作式的，部分任务可能仍在收尾。') : null,
      e('div', { style: { color: C.faint, marginTop: 4 } }, '会话日志已保留，可用 resume 恢复。'),
      e('button', {
        onClick: () => setResult(null),
        style: { ...btn(false, false), marginTop: 6 },
      }, '知道了'),
    ) : null,

    // 建议行
    others.map((r) => e('div', {
      key: r.id,
      style: { fontSize: 12, color: C.dim, display: 'flex', gap: 6, alignItems: 'baseline' },
    },
      e('span', { style: { color: C.ok, flexShrink: 0 } }, '·'),
      e('span', null, r.hint || r.label),
    )),

    // 破坏性按钮
    stopItem ? e('div', {
      style: { paddingTop: 8, borderTop: `1px solid ${C.border}` },
    },
      e('button', {
        onClick: openPlan,
        disabled: loadingPlan,
        style: { ...btn(true, loadingPlan), width: '100%' },
      }, '关闭所有运行中任务'),
      e('div', { style: { fontSize: 11, color: C.faint, marginTop: 4, textAlign: 'center' } },
        stopItem.hint),
    ) : null,

    planErr ? e('div', { style: { fontSize: 11.5, color: C.over } }, planErr) : null,

    e('label', {
      style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', opacity: 0.75 },
    },
      e('input', { type: 'checkbox', checked: notifyOn, onChange: (ev) => toggleNotify(ev.target.checked) }),
      '超阈值时发浏览器通知',
    ),
  )
}

// ────────────────────────────────────────────────────────────
// 装配
//
// ★ 整段包在环境判断里。本模块依赖 window / fetch / Notification，
//   在 Node 里 import 时不能直接执行——否则抛「window is not defined」，
//   让人误以为 npm 包损坏。dsh 的客户端加载器在浏览器里跑，走 if 分支。
// ────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && typeof window.__ModuleLoader__ !== 'undefined') {
  window.__ModuleLoader__.load({
  id: 'dsh-token-guard',
  factory: (require) => {
    const module = { exports: {} }
    // ★ React 必须存到模块作用域的变量里。
    //   写成裸标识符 React.useState 会依赖隐式全局，浏览器里可能直接报错。
    ;({ jsx: h, jsxs: hs } = require('react/jsx-runtime'))
    React = require('react')
    try { ui = require('@deepseek-ai/dsh-client-ui-primitives') } catch { ui = null }

    const apply = (ctx) => {
      const first = poll(true)
      const Panel = (p) => e(BudgetPanel, { ...p, alert: p.alert ?? first })

      // 优先挂输入框上方（日常可见），退回设置页
      const mount = (slotName, id, label, order) => {
        try {
          ctx.slots.inject(slotName, () => ctx.slots.register({
            name: slotName, id, order, label: () => label,
          }, Panel))
          return true
        } catch (err) {
          console.warn(`[token-guard] 槽位 ${slotName} 挂载失败:`, err?.message ?? err)
          return false
        }
      }

      const ok = mount('conversation.input.dock', 'token-guard-dock', '预算', 10)
        || mount('settings.section', 'token-guard-settings', 'Token 预算', 70)
      if (!ok) console.warn('[token-guard] 未能挂载到任何 UI 槽位，仅保留 /budget 命令')
    }

    module.exports = { inject: ['slots'], apply }
    return module.exports
  },
})
} else {
  // ★ 本模块依赖浏览器全局（window.__ModuleLoader__、fetch、Notification）。
  //   在 Node 环境下被import 时给出明确说明，而不是抛
  //   「window is not defined」让人误以为包损坏。
  //   dsh 的客户端加载器在浏览器里执行，走上面的分支。
  console.warn(
    '[dsh-token-guard] client/index.mjs 是浏览器端模块，需由 dsh 客户端加载器执行；'
    + '在 Node 里 import 它不会生效（宿主功能请用 dsh-token-guard 主入口）。'
  )
}
