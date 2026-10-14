/**
 * dsh-token-guard — 宿主端入口
 *
 * 原则：
 *  - 零硬依赖：可选服务缺失时降级运行，不阻塞加载
 *  - 只读：不拦截、不中止、不改写任何模型请求
 *  - 可卸载：所有副作用经 ctx.effect 注册，返回清理函数
 *
 * ★ 关于「提醒怎么送达用户」——已核实的框架限制：
 *   dsh 没有 UI 通知 API（无 notification / notice 服务）。
 *   agent.inject() 会把内容塞进模型上下文，既消耗 token 又让模型看到提醒，不可用。
 *   因此提醒分两路：
 *     1. HTTP 接口 /api/token-guard/alert —— 客户端轮询，带文案
 *     2. 客户端 slot 面板 —— 余量环 + 浏览器 Notification
 *   宿主侧不主动 console.log 刷屏，那对用户不可见。
 */

import { dshHome, collectAll } from './src/collector.mjs'
import { ingest, today, readBudget, writeDay, listDays, summaryOf } from './src/ledger.mjs'
import { dispatch, dispatchAsync, cmdStatus } from './src/commands.mjs'
import { checkNotify, evaluate } from './src/threshold.mjs'
import { planStop, executeStop } from './src/guard.mjs'
import { buildAlert, normalizeLevel } from './src/notifier.mjs'
import { isPeak, describeOffpeakWait } from './src/pricing.mjs'

export const name = 'dsh-token-guard'
export const inject = ['commands']

const log = (...a) => console.log('[token-guard]', ...a)

export function apply(ctx, config = {}) {
  // ★ 运行时求值，不要提到模块顶层。
  //   顶层求值会在 import 时锁定 DSH_HOME，导致测试或多实例场景下
  //   改了环境变量也不生效，甚至把测试数据写进用户真实目录。
  const home = dshHome()

  // 配置层默认值（仅在用户未设置时生效）
  if (config.dailyBudgetCny > 0 || Array.isArray(config.thresholds)) {
    const b = readBudget(home)
    const patch = {}
    if (b.dailyBudgetCny === 0 && config.dailyBudgetCny > 0) patch.dailyBudgetCny = config.dailyBudgetCny
    if (b.dailyBudgetTokens === 0 && config.dailyBudgetTokens > 0) patch.dailyBudgetTokens = config.dailyBudgetTokens
    if (Object.keys(patch).length) Object.assign(b, patch)
  }

  // ── 摄取 ──────────────────────────────────────────────
  // 只读会话日志。每次都全量重算而非增量累加：
  // 账本由 usage 记录完全决定，重算天然幂等，能自愈任何损坏与遗漏。
  // 实测 10 个会话文件约 150ms，加载时与每轮各跑一次完全可接受。
  const INGEST_TTL = 20_000
  let lastIngest = 0

  const refresh = ({ force = false } = {}) => {
    if (!force && Date.now() - lastIngest < INGEST_TTL) return 0
    try {
      const { records } = collectAll({ home })
      lastIngest = Date.now()
      if (records.length === 0) return 0
      const { last } = ingest(home, records)
      return last?.turns ?? 0
    } catch (e) {
      lastIngest = Date.now()          // 失败也记时间，避免反复重试
      log('摄取失败（不影响其他功能）:', e.message)
      return 0
    }
  }

  /** 检查阈值，返回提醒负载或 null。 */
  const pollAlert = ({ at = Date.now() } = {}) => {
    try {
      const day = today(home, at)
      const budget = readBudget(home)
      const hit = checkNotify(day, budget)   // 内部做每档每日去重
      if (!hit) return null
      // 命中后立即落盘，把 notified 标记持久化，避免重启后重复提醒
      writeDay(home, day)
      return buildAlert({ day, budget, hit, at })
    } catch (e) {
      log('阈值检查失败:', e.message)
      return null
    }
  }

  ctx.effect(() => {
    const n = refresh({ force: true })
    log(`已载入用量：${n} 轮（dsh home: ${home}）`)
    // 启动即检查一次，补上离线期间可能越过的档位
    pollAlert()
  }, 'token-guard: initial load')

  // 定期刷新：补齐离线期间的用量，并在跨越阈值时提醒
  ctx.effect(() => {
    const timer = setInterval(() => {
      refresh()
      const alert = pollAlert()
      if (alert?.shouldNotify) {
        // 宿主只记录，不刷屏。客户端通过 /api/token-guard/alert 拉取并弹通知。
        log(`${alert.title}（${alert.pct}%）· /budget 查看详情`)
      }
    }, 60_000)
    return () => clearInterval(timer)
  }, 'token-guard: poller')

  // ── 超预算防护：关闭所有任务 ────────────────────────────
  //
  // ★ 破坏性功能，两条硬规则：
  //   1. **永不自动执行**。超阈值只提醒，由用户显式下令才停止。
  //   2. plan 先于 stop。先看影响范围，再决定要不要停。
  //
  // agents 服务不可用时整体降级——/budget 其余功能不受影响。
  const guard = ctx.get('agents') ? {
    plan: () => planStop(ctx),
    stop: (opts) => executeStop(ctx, opts),
    alertSummary: () => {
      const day = today(home)
      const st = evaluate(day, readBudget(home))
      return {
        cost: st.cost,
        budget: readBudget(home).dailyBudgetCny,
        pct: st.pct,
      }
    },
  } : null

  if (!guard) log('agents 服务不可用，/budget plan 与 stop 不可用')

  // ── 斜杠命令 ───────────────────────────────────────────
  ctx.commands.register({
    name: 'budget',
    description: '每日token 预算：查用量、设阈值、看归因、超预算关闭任务',
    input: { hint: '[set 50 | why | plan | stop --all | history 7]' },
    async handler({ rawInput }) {
      try {
        refresh()
        return { kind: 'success', text: await dispatchAsync(home, rawInput, guard) }
      } catch (e) {
        return { kind: 'error', text: `预算命令出错：${e.message}` }
      }
    },
  })

  // ── HTTP 接口：供客户端面板轮询 ────────────────────────
  const webServer = ctx.get('webServer')
  if (webServer) {
    ctx.effect(() => {
      const json = (res, body, code = 200) => {
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(body))
      }

      const route = {
        kind: 'prefix',
        path: '/api/token-guard',
        handler: async (req, res) => {
          try {
            const url = String(req.url ?? '/')
            const sub = url.split('?')[0].replace(/^\/api\/token-guard/, '') || '/'

            if (sub === '/' || sub === '/alert') {
              refresh()
              const day = today(home)
              const budget = readBudget(home)
              // ★ 只查询不消费 notified。
              //   客户端每 30s 轮询一次，若在此消费标记，提醒将永远发不出去。
              return json(res, buildAlert({ day, budget, at: Date.now() }))
            }

            if (sub === '/history') {
              const days = listDays(home)
              return json(res, { days: days.map((d) => summaryOf(home, d)) })
            }

            if (sub === '/budget') {
              return json(res, readBudget(home))
            }

            // ── 超预算防护接口 ──
            // ★ 破坏性操作：GET /stop 只返回计划，绝不执行。
            //   真正执行必须显式带 confirm=true，
            //   且默认 dryRun——避免误触或被 CSRF 意外触发。
            if (sub === '/plan') {
              if (!guard) return json(res, { ok: false, error: 'agents 服务不可用' }, 503)
              return json(res, { ok: true, plan: planStop(ctx) })
            }

            if (sub === '/stop') {
              if (!guard) return json(res, { ok: false, error: 'agents 服务不可用' }, 503)

              const q = new URLSearchParams(url.split('?')[1] ?? '')
              const confirmed = q.get('confirm') === 'true'
              const dryRun = q.get('dryRun') !== 'false'   // ★ 默认预演

              if (!confirmed) {
                const p = planStop(ctx)
                return json(res, {
                  ok: false,
                  error: '这是破坏性操作。请先 GET /plan 预览，再带 confirm=true 重试。',
                  plan: p,
                }, 409)
              }

              const mode = q.get('mode') === 'currentTurn' ? 'currentTurn' : 'everything'
              const r = await executeStop(ctx, { mode, dryRun })
              return json(res, r, r.ok ? 200 : 500)
            }

            return json(res, { ok: false, error: `未知子路径 ${sub}` }, 404)
          } catch (e) {
            return json(res, { ok: false, error: e.message }, 500)
          }
        },
      }

      // ★ register 通常返回 disposer，必须回传给 effect，
      //   否则插件卸载后路由仍挂在 webServer 上（幽灵残留）。
      const dispose = webServer.register(route)
      return typeof dispose === 'function' ? dispose : () => {
        // 兜底：若 register 不返回 disposer，尝试用同 id 覆盖注册
        try { webServer.register({ ...route, disabled: true }) } catch {}
      }
    }, 'token-guard: http routes')
  } else {
    log('webServer 不可用，仅提供 /budget 命令（客户端面板不可用）')
  }

  // ── 实时补充：会话事件到达时立刻检查 ───────────────────
  // 轮询有最长 60s 延迟；这里做低延迟补充。
  // 注意：不使用 agent.inject —— 那会把提醒塞进模型上下文。
  const sessions = ctx.get('sessions')
  if (sessions) {
    ctx.effect(() => {
      const unhook = ctx.on('session/event', (_session, evt) => {
        if (evt?.type !== 'assistant/message') return
        refresh({ force: true })
        const alert = pollAlert()
        if (alert?.shouldNotify) {
          log(`${alert.title}（${alert.pct}%）· /budget 查看详情`)
        }
      })
      return typeof unhook === 'function' ? unhook : undefined
    }, 'token-guard: session listener')
  } else {
    log('sessions 服务不可用，靠 60s 轮询更新（延迟略高但可用）')
  }
}
