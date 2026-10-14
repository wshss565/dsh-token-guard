/**
 * 生成 README 用的输出预览。
 *
 * ⚠️ 诚实声明：**这不是真机 dsh 截图**。
 *   dsh 尚未安装、Web UI 拍不到，这里是用真实会话数据跑出的命令输出，
 *   套上接近 dsh Web UI 的外观渲染而成。
 *   目的是让读者看清「输出长什么样」，不代表宿主 UI 的像素级还原。
 *   真机截图待安装 dsh 后补。
 *
 * 用法：node tools/make-preview.mjs
 * 产出：docs/preview.html（用 Edge 截图为 docs/preview.png）
 */

import { mkdtempSync, mkdirSync, cpSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
// ★ Windows 上import() 只接受 file:// URL，绝对路径 'D://...' 会被拒绝。
const mod = (rel) => import(pathToFileURL(join(root, rel)).href)

// ── 隔离环境 + 真实数据 ──
const src = join(homedir(), '.dsh', 'sessions')
const home = mkdtempSync(join(tmpdir(), 'tg-prev-'))
mkdirSync(join(home, 'token-guard'), { recursive: true })
for (const ws of readdirSync(src)) {
  for (const s of readdirSync(join(src, ws))) {
    const to = join(home, 'sessions', ws, s)
    mkdirSync(to, { recursive: true })
    for (const f of readdirSync(join(src, ws, s))) {
      if (f.endsWith('.zstd')) { try { cpSync(join(src, ws, s, f), join(to, f)) } catch {} }
    }
  }
}
process.env.DSH_HOME = home

const { ingest, writeBudget, listDays, readDay, summaryOf } = await mod('src/ledger.mjs')
const { collectAll } = await mod('src/collector.mjs')
const { dispatch } = await mod('src/commands.mjs')

const { records } = collectAll({ home })
const { last } = ingest(home, records)
writeBudget(home, { dailyBudgetCny: 2, notifyLevel: 'normal' })

// 取最近有数据的一天
const days = listDays(home)
const latest = days[days.length - 1]

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  records: records.length,
  files: 10,
  days,
  latest,
  latestSummary: summaryOf(home, latest),
  // 高峰场景用构造数据（真实数据全落在空闲时段）
  outputs: {
    // ★ 全部用「最近有数据的一天」，避免同图里出现 今日¥0.00 与 ¥3.07 自相矛盾
    why: dispatch(home, 'why ' + latest),
    history: dispatch(home, `history ${days.length}`),
  },
}

writeFileSync(join(root, 'docs', 'preview-data.json'), JSON.stringify(out, null, 2), 'utf8')
console.log('数据已生成：docs/preview-data.json')
console.log('  真实记录数:', records.length)
console.log('  日期:', days.join(', '))
console.log('  最新日:', latest, '花费 ¥' + out.latestSummary.cost.toFixed(2))

rmSync(home, { recursive: true, force: true })
