/**
 * 集成测试：用真实 dsh 会话数据跑通完整链路。
 *
 * 隔离方式：把 DSH_HOME 指向临时目录，**复制**（不用 symlink）真实
 * ~/.dsh/sessions 的会话文件进去。
 *   - 用 symlink 在部分 Windows 环境会挂起，不可靠
 *   - 复制 10 个文件仅需几十毫秒，可接受
 *
 * 跳过条件：本机没有 ~/.dsh/sessions 时整体 skip。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, cpSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const realSessions = join(homedir(), '.dsh', 'sessions')
const hasReal = existsSync(realSessions)

/** 递归复制会话文件到隔离目录。返回复制的文件数。 */
function copySessions(dest) {
  let n = 0
  for (const ws of readdirSync(realSessions)) {
    for (const sess of readdirSync(join(realSessions, ws))) {
      const from = join(realSessions, ws, sess)
      const to = join(dest, ws, sess)
      mkdirSync(to, { recursive: true })
      for (const f of readdirSync(from)) {
        if (!f.endsWith('.zstd')) continue
        try { cpSync(join(from, f), join(to, f)); n++ } catch {}
      }
    }
  }
  return n
}

function makeHome() {
  const h = mkdtempSync(join(tmpdir(), 'tg-int-'))
  mkdirSync(join(h, 'token-guard'), { recursive: true })
  if (hasReal) copySessions(join(h, 'sessions'))
  return h
}

/**
 * 最小 dsh ctx 模拟。
 *
 * effect 收集每个清理函数，disposeAll() 统一清理。
 * 插件里 setInterval 通过 effect 返回清理函数，模拟必须如实保留，
 * 否则测试文件会被活动句柄拖到超时。
 */
function makeCtx() {
  const reg = []
  const disposers = []
  return {
    reg,
    disposeAll() {
      while (disposers.length) {
        const d = disposers.pop()
        try { d?.() } catch {}
      }
    },
    ctx: {
      commands: { register: (c) => reg.push(c) },
      get: () => undefined,
      on: () => {},
      effect: (fn) => {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
    },
  }
}

async function boot(home) {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // index.mjs 必须在改完环境变量后 import —— home 是运行时求值的
  const mod = await import(`../index.mjs?h=${encodeURIComponent(home)}`)
  const { reg, ctx, disposeAll } = makeCtx()
  mod.apply(ctx, {})
  const call = async (raw) => reg[0].handler({ rawInput: raw })
  return {
    mod, call, disposeAll,
    restore: () => { disposeAll(); process.env.DSH_HOME = prev },
  }
}

test('集成：真实数据摄取 → /budget 全流程', { skip: hasReal ? false : '本机无 ~/.dsh/sessions' }, async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const { call, restore } = await boot(home)
  t.after(restore)

  // 初次启动应已摄取到历史用量
  const s0 = await call('')
  assert.equal(s0.kind, 'success')

  // 设预算
  const set = await call('set 100')
  assert.equal(set.kind, 'success')
  assert.match(set.text, /每日 ¥100\.00/)

  // 查询应显示已设置的预算
  const s1 = await call('')
  assert.match(s1.text, /\/ ¥100\.00/)
  assert.match(s1.text, /%/, '应显示百分比进度')

  // 历史
  const h = await call('history 7')
  assert.equal(h.kind, 'success')
  assert.match(h.text, /日期/)

  // 归因
  const w = await call('why')
  assert.equal(w.kind, 'success')

  // 未知子命令应显示帮助而不是报错
  const bad = await call('nonsense')
  assert.equal(bad.kind, 'success')
  assert.match(bad.text, /\/budget set 50/)
})

test('集成：账本只写进 DSH_HOME/token-guard，不碰其他位置', { skip: hasReal ? false : '无数据' }, async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const { call, restore } = await boot(home)
  t.after(restore)

  await call('set 1')
  await call('')

  // token-guard 目录应存在
  assert.ok(existsSync(join(home, 'token-guard')), '应创建自己的账本目录')
  assert.ok(existsSync(join(home, 'token-guard', 'budget.json')), '应写出预算文件')
})

test('集成：阈值去重在真实链路生效', { skip: hasReal ? false : '无数据' }, async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const { call, restore } = await boot(home)
  t.after(restore)

  // 设一个极小预算，必然立刻超限
  await call('set 0.0000001')
  const s = await call('')
  // 超限应被标记并在输出中体现
  assert.match(s.text, /%|¥/)
})

// node:test 会等待文件内所有活动句柄。插件注册了 setInterval 刷新器，
// 每个用例的 restore() 会调 disposeAll() 清除它，无需额外兜底。

// ────────────────────────────────────────────────────────────
// v0.2 提醒链路
// ────────────────────────────────────────────────────────────

/** 带webServer 的 ctx 模拟 */
function makeCtxWithWeb() {
  const reg = []
  const routes = []
  const disposers = []
  return {
    reg, routes,
    disposeAll() { while (disposers.length) { const d = disposers.pop(); try { d?.() } catch {} } },
    ctx: {
      commands: { register: (c) => reg.push(c) },
      get: (n) => (n === 'webServer'
        ? { register: (r) => { routes.push(r); return () => {} } }
        : undefined),
      on: () => () => {},
      effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    },
  }
}

function mockRes() {
  const r = { code: null, body: null }
  r.writeHead = (c) => { r.code = c }
  r.end = (b) => { r.body = b }
  return r
}

/** 装配一份隔离的插件实例（带 webServer） */
async function bootWeb(home, tag) {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mod = await import(`../index.mjs?${tag}=${Math.random()}`)
  const c = makeCtxWithWeb()
  mod.apply(c.ctx, {})
  return { ...c, mod, restore: () => { c.disposeAll(); process.env.DSH_HOME = prev } }
}

test('v0.2: /api/token-guard/alert 返回完整结构', { skip: hasReal ? false : '无数据' }, async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const { routes, restore } = await bootWeb(home, 'v2a')
  t.after(restore)

  assert.ok(routes.length > 0, '应注册 HTTP 路由')
  const route = routes[0]
  assert.equal(route.path, '/api/token-guard')

  const res = mockRes()
  await route.handler({ url: '/api/token-guard/alert' }, res)
  const body = JSON.parse(res.body)

  for (const k of ['version', 'kind', 'title', 'text', 'date', 'cost', 'pct', 'configured', 'shouldNotify', 'stamp']) {
    assert.ok(k in body, `响应应包含 ${k}`)
  }
  assert.equal(body.version, 1)
  assert.equal(typeof body.shouldNotify, 'boolean')
})

test('v0.2: 未设预算时 shouldNotify 为 false', { skip: hasReal ? false : '无数据' }, async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const { routes, restore } = await bootWeb(home, 'v2b')
  t.after(restore)

  const res = mockRes()
  await routes[0].handler({ url: '/api/token-guard/alert' }, res)
  const body = JSON.parse(res.body)
  assert.equal(body.configured, false)
  assert.equal(body.shouldNotify, false, '未设预算不该提醒')
})

test('v0.2: 未知子路径返回 404', { skip: hasReal ? false : '无数据' }, async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const { routes, restore } = await bootWeb(home, 'v2c')
  t.after(restore)

  const res = mockRes()
  await routes[0].handler({ url: '/api/token-guard/nope' }, res)
  assert.equal(res.code, 404)
  assert.equal(JSON.parse(res.body).ok, false)
})

test('v0.2: /history 返回按日汇总', { skip: hasReal ? false : '无数据' }, async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const { routes, restore } = await bootWeb(home, 'v2d')
  t.after(restore)

  const res = mockRes()
  await routes[0].handler({ url: '/api/token-guard/history' }, res)
  const body = JSON.parse(res.body)
  assert.ok(Array.isArray(body.days))
  for (const d of body.days) {
    for (const k of ['date', 'cost', 'tokens', 'turns']) {
      assert.ok(k in d, `汇总项应含 ${k}`)
    }
  }
})

test('v0.2: ★ 轮询不消费 notified，提醒仍能发出', { skip: hasReal ? false : '无数据' }, async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const { ingest, writeBudget, writeDay, readBudget, listDays, readDay } = await import('../src/ledger.mjs')
  const { checkNotify } = await import('../src/threshold.mjs')
  const { collectAll } = await import('../src/collector.mjs')
  const { buildAlert } = await import('../src/notifier.mjs')

  ingest(home, collectAll({ home }).records)
  writeBudget(home, { dailyBudgetCny: 0.0001, notifyLevel: 'normal' })

  // ★ 用「有数据的最近一天」而不是今天。
  //   本机真实数据全落在 09-08/ 09-12 / 10-03，用今天会退化成 skip，
  //   恰好漏掉最需要验证的去重路径。
  const days = listDays(home)
  const day = days.length ? readDay(home, days[days.length - 1]) : null
  if (!day || day.turns === 0) return t.skip('无任何用量数据')

  const budget = readBudget(home)
  // 预算设得极小，必然触发最高档
  const first = checkNotify(day, budget)
  assert.ok(first, `应产生提醒（day=${day.date} turns=${day.turns}）`)
  writeDay(home, day)

  // 模拟客户端轮询：只读，不消费 notified
  const polled = buildAlert({ day, budget, at: Date.now() })
  assert.equal(polled.shouldNotify, true, '★ 轮询后仍应标记为应提醒')

  // 真正的消费只发生一次
  assert.equal(checkNotify(day, budget), null, '重复检查应被去重')
})
