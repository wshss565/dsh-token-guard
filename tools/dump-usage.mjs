#!/usr/bin/env node
/**
 * dump-usage.mjs — 从本地 dsh 会话日志中提取 token 用量。
 *
 * 用途有二：
 *   1. 自查用量，不依赖插件是否安装
 *   2. 为 v0.1 的测试生成 fixture
 *
 * 用法:
 *   node tools/dump-usage.mjs                  # 汇总全部会话
 *   node tools/dump-usage.mjs --day2026-10-04  # 按日汇总
 *   node tools/dump-usage.mjs --json           # 输出 JSON
 *   node tools/dump-usage.mjs --csv            # 输出 CSV
 *
 * 只读。不写任何文件。
 *
 * 数据来源: ~/.dsh/sessions/<workspace>/<session>/session.v*.jsonl.zstd
 */

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

// ── 多帧 zstd 解析 ───────────────────────────────────────────────
// 注意: dsh 的 .zstd 是「每帧一个 JSON 行」的多帧结构。
// Node 的 zstdDecompressSync 只会解出第一帧（实测 192KB 文件仅得 229 字节），
// 必须逐帧遍历magic 才能拿到全部内容。
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeFrames(buf) {
  const out = []
  let off = 0
  while (off < buf.length) {
    const start = buf.indexOf(FRAME_MAGIC, off)
    if (start === -1) break
    let text = null
    for (let end = Math.min(buf.length, start + 64 * 1024 * 1024); end <= buf.length; end += 512 * 1024) {
      try {
        text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
        break
      } catch {}
    }
    if (text !== null) {
      for (const line of text.split('\n')) if (line.trim()) out.push(line)
      const next = buf.indexOf(FRAME_MAGIC, start + 4)
      if (next === -1) break
      off = next
    } else {
      off = start + 4
    }
  }
  return out
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isDirectory()) walk(p, out)
      else if (p.endsWith('.zstd')) out.push(p)
    } catch {}
  }
  return out
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function localDay(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function collect() {
  const sessions = walk(join(DSH_HOME, 'sessions'))
  const rows = []
  let malformed = 0

  for (const file of sessions) {
    let lines
    try { lines = decodeFrames(readFileSync(file)) } catch { continue }
    let currentModel = null

    for (const line of lines) {
      let evt
      try { evt = JSON.parse(line) } catch { malformed++; continue }

      if (evt.type === 'model/selection') {
        currentModel = evt.data?.model ?? currentModel
        continue
      }
      if (evt.type !== 'assistant/message') continue

      const u = evt.data?.usage
      if (!u) continue

      const input = num(u.inputTokens)
      const output = num(u.outputTokens)
      const cacheRead = num(u.cacheReadTokens)
      const cacheWrite = num(u.cacheWriteTokens)

      rows.push({
        time: num(evt.time),
        day: localDay(num(evt.time)),
        seq: num(evt.seq),
        session: file.split('sessions')[1].replace(/\\/g, '/'),
        model: currentModel ?? 'unknown',
        input, output, cacheRead, cacheWrite,
        reasoning: num(u.reasoningTokens),
        reportedTotal: num(u.totalTokens),
        // 实测 237/237 成立: total = input + output + cacheRead
        computedTotal: input + output + cacheRead,
      })
    }
  }
  return { rows, fileCount: sessions.length, malformed }
}

// ── 输出 ────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const { rows, fileCount, malformed } = collect()
const dayArg = args.find((a) => a.startsWith('--day'))?.split('=')[1]
const filtered = dayArg ? rows.filter((r) => r.day === dayArg) : rows

const sum = (k) => filtered.reduce((a, r) => a + r[k], 0)
const byModel = {}
const byDay = {}
for (const r of filtered) {
  byModel[r.model] ??= { turns: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0 }
  byDay[r.day] ??= { turns: 0, input: 0, output: 0, cacheRead: 0 }
  for (const k of ['input', 'output', 'cacheRead', 'reasoning']) byModel[r.model][k] += r[k]
  byModel[r.model].turns++
  for (const k of ['input', 'output', 'cacheRead']) byDay[r.day][k] += r[k]
  byDay[r.day].turns++
}

const mismatch = filtered.filter((r) => r.reportedTotal !== r.computedTotal).length

if (args.includes('--json')) {
  console.log(JSON.stringify({
    dshHome: DSH_HOME, fileCount, malformed, rows: filtered,
    totals: { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), reasoning: sum('reasoning') },
    byModel, byDay, totalMismatch: mismatch,
  }, null, 2))
} else if (args.includes('--csv')) {
  console.log('day,model,turns,input,output,cacheRead,reasoning')
  for (const [m, v] of Object.entries(byModel)) {
    console.log(`${dayArg || 'all'},${m},${v.turns},${v.input},${v.output},${v.cacheRead},${v.reasoning}`)
  }
} else {
  console.log(`dsh home: ${DSH_HOME}`)
  console.log(`scanned  : ${fileCount} files, ${rows.length} usage records${malformed ? `, ${malformed} malformed` : ''}`)
  if (dayArg) console.log(`day      : ${dayArg}`)
  console.log()
  console.log('model                        turns      input     output  cacheRead   reasoning')
  for (const [m, v] of Object.entries(byModel)) {
    console.log(
      `${m.padEnd(26)} ${String(v.turns).padStart(7)} ${String(v.input).padStart(10)} ` +
      `${String(v.output).padStart(10)} ${String(v.cacheRead).padStart(10)} ${String(v.reasoning).padStart(10)}`
    )
  }
  const t = { turns: filtered.length, input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), reasoning: sum('reasoning') }
  console.log('-'.repeat(78))
  console.log(
    `${'TOTAL'.padEnd(26)} ${String(t.turns).padStart(7)} ${String(t.input).padStart(10)} ` +
    `${String(t.output).padStart(10)} ${String(t.cacheRead).padStart(10)} ${String(t.reasoning).padStart(10)}`
  )
  console.log()
  console.log(`total = input + output + cacheRead : ${mismatch === 0 ? 'OK (全部一致)' : `${mismatch} 条不一致`}`)
  console.log()
  console.log('注意: inputTokens 不含缓存命中部分，计价必须三段分开算。')
}
