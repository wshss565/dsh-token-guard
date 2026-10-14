/**
 * build-preview.mjs — 生成 README 用的输出预览图
 *
 * ⚠️ 产出的是**输出预览**，不是真机 dsh 截图。
 *   dsh 需用户自行安装；本脚本用本机真实会话数据跑出命令输出，
 *   套上接近 dsh Web UI 的外观渲染，用于展示「输出长什么样」。
 *
 * 用法：node tools/build-preview.mjs
 * 依赖：msedge（无头截图）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const docs = join(root, 'docs')

// 1. 生成数据
execFileSync(process.execPath, [join(here, 'make-preview.mjs')], { stdio: 'inherit' })

// 2. 内联进 HTML（file:// 下 fetch 会被 CORS 拦，终端会渲染成空白）
const data = JSON.parse(readFileSync(join(docs, 'preview-data.json'), 'utf8'))
let html = readFileSync(join(docs, 'preview.template.html'), 'utf8')

const block = `<script id="preview-data" type="application/json">${JSON.stringify(data)}</script>\n`
// 用正则定位渲染脚本，避开空行/缩进差异
const SCRIPT_RE = /<script>\s*\n\s*const esc/
if (!SCRIPT_RE.test(html)) {
  console.error('预览页模板结构已变：找不到渲染脚本锚点')
  process.exit(1)
}
html = html.replace(SCRIPT_RE, block + '<script>\nconst esc')

const iData = html.indexOf('id="preview-data"')
const iExec = html.indexOf('const esc =')
if (iData === -1 || iExec === -1 || iData > iExec) {
  console.error(`预览页脚本顺序错误：data@${iData} exec@${iExec}`)
  process.exit(1)
}
writeFileSync(join(docs, 'preview.html'), html, 'utf8')

// 3. 截图
const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p))

if (!edge) {
  console.log('未找到 Edge，跳过截图。preview.html 已生成，可手动打开。')
  process.exit(0)
}

const out = join(docs, 'preview.png')
execFileSync(edge, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1000,1500',
  `--screenshot=${out}`,
  '--virtual-time-budget=3000',
  pathToFileURL(join(docs, 'preview.html')).href,
], { stdio: ['ignore', 'ignore', 'pipe'] })

console.log('已生成 docs/preview.png')
