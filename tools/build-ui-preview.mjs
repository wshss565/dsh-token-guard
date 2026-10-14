/**
 * build-ui-preview.mjs — 生成客户端面板 UI 预览
 *
 * ⚠️ 产出的是**UI 形态预览**，不是真机 dsh 截图。
 *   客户端代码依赖 dsh 注入的 ctx.slots 与 React，无法独立运行。
 *   数字与处置建议来自 buildAlert() 真实输出，任务列表为模拟数据。
 *
 * 用法：node tools/build-ui-preview.mjs
 * 产出：docs/ui-preview.html（Edge 截图为 docs/ui-preview.png）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const docs = join(root, 'docs')
const mod = (rel) => import(pathToFileURL(join(root, rel)).href)

const { buildAlert } = await mod('src/notifier.mjs')
const { newDay } = await mod('src/threshold.mjs')

const bj = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 8, min)
function mkDay(cny, tier = 'peak', over = false) {
  const d = newDay('2026-10-07')
  d.byTier[tier].costMicro = Math.round(cny * 1e6)
  d.byTier[tier].turns = 10
  d.turns = 10
  d.input = 1000
  d.overLimit = over
  return d
}
const budget = { dailyBudgetCny: 50, notifyLevel: 'normal' }

const data = {
  ok: buildAlert({ day: mkDay(12, 'offpeak'), budget, at: bj(2026, 10, 3, 14) }),
  warn: buildAlert({ day: mkDay(42), budget, at: bj(2026, 10, 7, 15) }),
  over: buildAlert({ day: mkDay(56, 'peak', true), budget, at: bj(2026, 10, 7, 17, 20) }),
}

let html = readFileSync(join(docs, 'ui-preview.template.html'), 'utf8')
const RE = /<script id="alert-data" type="application\/json">__DATA__<\/script>/
if (!RE.test(html)) {
  console.error('模板结构已变：找不到 __DATA__ 占位')
  process.exit(1)
}

// 内联 JSON 里的 </script> 会提前闭合 script 块导致整页空白。
// 数据里含工具输出（如「<html>」片段）时必须转义。
const safeJson = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>')
const block = `<script id="alert-data" type="application/json">${safeJson}</script>`
html = html.replace(RE, block)

const OPEN = '<script id="alert-data" type="application/json">'
const iData = html.indexOf(OPEN)
const iUse = html.indexOf('JSON.parse(document.getElementById(')
if (iData === -1 || iUse === -1 || iData > iUse) {
  console.error(`脚本顺序错误：data@${iData} use@${iUse}`)
  process.exit(1)
}

// 校验写入的 HTML 里数据块确实是合法 JSON——
// 用「重新提取 + 逆转义」的方式，避免自己切片切错。
const start = iData + OPEN.length
const end = html.indexOf('</script>', start)
if (end === -1) {
  console.error('数据块未闭合：可能被内容里的 </script> 截断')
  process.exit(1)
}
try {
  JSON.parse(html.slice(start, end).replace(/<\\\/script>/g, '</script>'))
} catch (e) {
  console.error('内联 JSON 不合法:', e.message)
  process.exit(1)
}

writeFileSync(join(docs, 'ui-preview.html'), html, 'utf8')
writeFileSync(join(docs, 'ui-preview.data.json'), JSON.stringify(data, null, 2), 'utf8')

// 截图
const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p))

if (!edge) { console.log('未找到 Edge，跳过截图'); process.exit(0) }

execFileSync(edge, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1000,1250',
  `--screenshot=${join(docs, 'ui-preview.png')}`,
  '--virtual-time-budget=3000',
  pathToFileURL(join(docs, 'ui-preview.html')).href,
], { stdio: ['ignore', 'ignore', 'pipe'] })

console.log('已生成 docs/ui-preview.html与 ui-preview.png')
