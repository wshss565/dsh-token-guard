import assert from 'node:assert/strict'
import { test } from 'node:test'

import { planStop, executeStop, MODE } from '../src/guard.mjs'
import { newDay } from '../src/threshold.mjs'
import { dispatch, dispatchAsync, cmdStop, cmdPlan } from '../src/commands.mjs'

/** 构造假的 agents 服务 */
function fakeAgents(list = [], { whenIdleDelay = 0, throwOnList = false } = {}) {
  const calls = []
  const agents = new Map()
  for (const a of list) agents.set(a.id, a)
  return {
    calls,
    service: {
      list: () => { if (throwOnList) throw new Error('list boom'); return list },
      get: (id) => agents.get(id),
      roots: () => list,
    },
  }
}

function fakeAgent(id, { status = 'running', parent = null, noCancel = false, noIdle = false } = {}) {
  const a = {
    id,
    status,
    options: parent ? { parentAgent: parent } : {},
    session: { id },
    _canceled: null,
  }
  if (!noCancel) {
    a.cancel = (cause, opts) => { a._canceled = { cause, opts } }
  }
  if (!noIdle) a.whenIdle = () => Promise.resolve()
  return a
}

const ctxOf = (service) => ({ get: (n) => (n === 'agents' ? service : undefined) })

// ─────────────────────── plan ───────────────────────
test('plan: agents 服务不可用时优雅降级', () => {
  const p = planStop({ get: () => undefined })
  assert.equal(p.ok, false)
  assert.match(p.reason, /agents 服务不可用/)
  assert.equal(p.summary.total, 0)
})

test('plan: list 抛错时不崩', () => {
  const { service } = fakeAgents([], { throwOnList: true })
  const p = planStop(ctxOf(service))
  assert.equal(p.ok, false)
  assert.match(p.reason, /list boom/)
})

test('plan: 无 agent 时返回空计划', () => {
  const { service } = fakeAgents([])
  const p = planStop(ctxOf(service))
  assert.equal(p.ok, true)
  assert.equal(p.summary.total, 0)
  assert.equal(p.summary.stoppable, 0)
})

test('plan: 区分可停止/空闲/子agent', () => {
  const a = fakeAgent('a-running')
  const b = fakeAgent('b-idle', { status: 'idle' })
  const c = fakeAgent('c-sub', { parent: 'a-running' })
  const { service } = fakeAgents([a, b, c])
  const p = planStop(ctxOf(service))
  assert.equal(p.summary.total, 3)
  assert.equal(p.summary.stoppable, 2, '子 agent 应被跳过（running + idle）')
  assert.equal(p.summary.idle, 1)
  // running 含子 agent —— 它确实在跑，只是我们不负责停它
  assert.equal(p.summary.running, 2)
  assert.equal(p.summary.skipped, 1)
})

test('plan: summary.running 含子agent，stopped 不含（口径不同）', () => {
  const parent = fakeAgent('p')
  const sub = fakeAgent('s', { parent: 'p' })
  const { service } = fakeAgents([parent, sub])
  const p = planStop(ctxOf(service))
  assert.equal(p.summary.running, 2, '两个都在跑')
  assert.equal(p.summary.stoppable, 1, '但只有一个归我们停')
  assert.equal(p.summary.skipped, 1)
})

test('plan: 子 agent 标记原因含 agent-busy', () => {
  const c = fakeAgent('c-sub', { parent: 'p' })
  const { service } = fakeAgents([c])
  const row = planStop(ctxOf(service)).agents[0]
  assert.equal(row.stoppable, false)
  assert.match(row.reason, /agent-busy|子 agent/)
})

test('plan: 不支持 cancel 的 agent 被标记跳过', () => {
  const a = fakeAgent('a', { noCancel: true })
  const { service } = fakeAgents([a])
  const row = planStop(ctxOf(service)).agents[0]
  assert.equal(row.stoppable, false)
  assert.match(row.reason, /cancel/)
})

// ─────────────────────── executeStop ───────────────────────
test('executeStop: dryRun 不调用任何 cancel', async () => {
  const a = fakeAgent('a')
  const { service } = fakeAgents([a])
  const r = await executeStop(ctxOf(service), { dryRun: true })
  assert.equal(r.dryRun, true)
  assert.equal(a._canceled, null, '★ 预演不得触发取消')
  assert.match(r.message, /未执行任何操作/)
})

test('executeStop: 默认模式清空队列（keepInbox false）', async () => {
  const a = fakeAgent('a')
  const { service } = fakeAgents([a])
  await executeStop(ctxOf(service), { dryRun: false })
  assert.ok(a._canceled, '应调用 cancel')
  assert.deepEqual(a._canceled.opts, { keepInbox: false })
  assert.deepEqual(a._canceled.cause, { kind: 'user' })
})

test('executeStop: currentTurn 模式保留队列', async () => {
  const a = fakeAgent('a')
  const { service } = fakeAgents([a])
  await executeStop(ctxOf(service), { mode: 'currentTurn', dryRun: false })
  assert.deepEqual(a._canceled.opts, { keepInbox: true })
})

test('executeStop: idle agent 不调用 cancel', async () => {
  const a = fakeAgent('a', { status: 'idle' })
  const { service } = fakeAgents([a])
  const r = await executeStop(ctxOf(service), { dryRun: false })
  assert.equal(a._canceled, null, '★ idle 的 agent 不该被 cancel')
  assert.equal(r.summary.noop, 1)
})

test('executeStop: 子 agent 不被停止', async () => {
  const parent = fakeAgent('p')
  const sub = fakeAgent('s', { parent: 'p' })
  const { service } = fakeAgents([parent, sub])
  const r = await executeStop(ctxOf(service), { dryRun: false })
  assert.equal(sub._canceled, null, '★ 子 agent 不应被停止')
  assert.ok(parent._canceled, '父 agent 应被停止')
  assert.equal(r.summary.stopped, 1)
  assert.equal(r.summary.skipped, 1)
  assert.equal(r.summary.failed, 0, '★ 子 agent 跳过不算失败')
  assert.equal(r.ok, true, '★ 有子 agent 不应导致整体失败')
})

test('executeStop: 逐个报告，单个失败不影响其他', async () => {
  const good = fakeAgent('good')
  const bad = fakeAgent('bad')
  bad.cancel = () => { throw new Error('cancel failed') }
  const also = fakeAgent('also')
  const { service } = fakeAgents([good, bad, also])
  const r = await executeStop(ctxOf(service), { dryRun: false })
  assert.equal(r.summary.stopped, 2)
  assert.equal(r.summary.failed, 1)
  assert.equal(r.ok, false)
  const failed = r.results.find((x) => x.id === 'bad')
  assert.match(failed.reason, /cancel failed/)
})

test('executeStop: 全部为子 agent 时拒绝执行', async () => {
  const sub = fakeAgent('s', { parent: 'p' })
  const { service } = fakeAgents([sub])
  const r = await executeStop(ctxOf(service), { dryRun: false })
  assert.match(r.message, /子 agent 由父级管理/)
  assert.equal(sub._canceled, null)
})

test('executeStop: 无 agent 时提示无任务', async () => {
  const { service } = fakeAgents([])
  const r = await executeStop(ctxOf(service), { dryRun: false })
  assert.match(r.message, /没有运行中的任务/)
})

test('executeStop: whenIdle 挂起时不无限等待', async () => {
  const a = fakeAgent('a')
  a.whenIdle = () => new Promise(() => {})   // 永不 resolve
  const { service } = fakeAgents([a])
  const t0 = Date.now()
  const r = await executeStop(ctxOf(service), { dryRun: false, timeoutMs: 120 })
  const dt = Date.now() - t0
  assert.ok(dt < 1000, `应在超时内返回，实测 ${dt}ms`)
  assert.equal(r.waited, false, '应报告未落定')
  assert.equal(r.summary.stopped, 1, '取消请求本身已发出')
})

// ─────────────────────── 命令层 ───────────────────────
test('cmdPlan: 无 guard 时提示不可用', () => {
  assert.match(cmdPlan(null), /不可用/)
})

test('cmdStop: 无 guard 时无参数仍给帮助 + 说明不可用', async () => {
  const out = await cmdStop(null, '')
  assert.match(out, /\/budget plan/)
  assert.match(out, /dry-run/)
  assert.match(out, /resume/)
  assert.match(out, /未接入 agents 服务/, '应同时说明为何不可用')
})

test('cmdStop: 有 guard 但无参数时给帮助', async () => {
  const a = fakeAgent('a')
  const { service } = fakeAgents([a])
  const guard = { plan: () => planStop(ctxOf(service)), stop: (o) => executeStop(ctxOf(service), o) }
  const out = await cmdStop(guard, '')
  assert.match(out, /\/budget plan/)
  assert.ok(!/未接入/.test(out), '有 guard 时不该说不可用')
})

test('cmdStop: 未指定目标时拒绝执行', async () => {
  const a = fakeAgent('a')
  const { service } = fakeAgents([a])
  const guard = { plan: () => planStop(ctxOf(service)), stop: (o) => executeStop(ctxOf(service), o) }
  const out = await cmdStop(guard, '随便什么')
  assert.match(out, /未指定目标/)
  assert.equal(a._canceled, null, '★ 不得误触发')
})

test('cmdStop: --all --dry-run 只预演', async () => {
  const a = fakeAgent('a')
  const { service } = fakeAgents([a])
  const guard = { plan: () => planStop(ctxOf(service)), stop: (o) => executeStop(ctxOf(service), o) }
  const out = await cmdStop(guard, '--all --dry-run')
  assert.match(out, /未执行任何操作/)
  assert.equal(a._canceled, null)
})

test('dispatch: 无 guard 时 help 标注 plan/stop 不可用', () => {
  const out = dispatch('/tmp/nonexistent-home-xyz', 'help')
  assert.match(out, /未接入 agents 服务/)
  assert.match(out, /\/budget set 50/)
})

test('dispatchAsync: stop 走异步分支', async () => {
  const a = fakeAgent('a')
  const { service } = fakeAgents([a])
  const guard = { plan: () => planStop(ctxOf(service)), stop: (o) => executeStop(ctxOf(service), o) }
  const out = await dispatchAsync('/tmp/nonexistent-home-xyz', 'stop --all --dry-run', guard)
  assert.match(out, /未执行任何操作/)
})
