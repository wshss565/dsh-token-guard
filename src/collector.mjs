/**
 * collector.mjs — 从 dsh 会话日志采集 token 用量
 *
 * 数据源：~/.dsh/sessions/<workspace>/<session>/session.v{3,4}.jsonl.zstd
 *
 * ⚠️ 多帧 zstd 坑（实测踩过）：
 *   dsh 的 .zstd 是「每帧一个 JSON 行」的多帧结构。
 *   Node 的 zlib.zstdDecompressSync 只解第一帧 —— 实测 192KB 文件仅得 229 字节。
 *   必须遍历 magic 逐帧解压。Node 22.15+ 才有 zstd 支持。
 */

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MAX_FRAME_WINDOW = 64 << 20// 单帧解压上限 64MB
const WINDOW_STEP = 512 << 10       // 尝试窗口的步进

/**
 * 进程级解析缓存。
 * 用 Map 而非模块级变量：测试可通过传`cache: new Map()` 隔离。
 */
const defaultCache = new Map()

/**
 * 解析 dsh 主目录。
 *
 * ★ 每次调用都重新读process.env.DSH_HOME，不做模块级缓存。
 *   缓存会导致测试或多实例场景下改了环境变量也不生效，
 *   进而把测试数据写进用户真实目录。
 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * 逐帧解压 zstd，返回所有帧拼成的文本。
 * 失败时降级为按单帧处理（兼容非多帧文件）。
 */
export function decodeZstdFrames(buf) {
  const out = []
  let off = 0
  while (off < buf.length) {
    const start = buf.indexOf(FRAME_MAGIC, off)
    if (start === -1) break

    let text = null
    for (let end = Math.min(buf.length, start + MAX_FRAME_WINDOW); end <= buf.length; end += WINDOW_STEP) {
      try {
        text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
        break
      } catch {}
    }

    if (text !== null) {
      for (const line of text.split('\n')) if (line.trim()) out.push(line)
      const next = buf.indexOf(FRAME_MAGIC, start + FRAME_MAGIC.length)
      if (next === -1) break
      off = next
    } else {
      // 该偏移不是帧起点，向后试探
      off = start + 1
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

export function listSessionFiles(home = dshHome()) {
  return walk(join(home, 'sessions'))
}

/**
 * 归一化一条 assistant/message 事件。
 * @returns {object|null} 无 usage 时返回 null（不抛错）
 */
export function normalizeMessage(evt) {
  const u = evt?.data?.usage
  if (!u) return null
  return {
    time: num(evt.time),
    seq: num(evt.seq),
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cacheRead: num(u.cacheReadTokens),
    cacheWrite: num(u.cacheWriteTokens),
    reasoning: num(u.reasoningTokens),
    reportedTotal: num(u.totalTokens),
    total: num(u.inputTokens) + num(u.outputTokens) + num(u.cacheReadTokens),
  }
}

/**
 * 从一个会话文件里提取全部用量记录。
 * 模型归属靠 model/selection 事件按时间序维护（assistant/message 里没有 model 字段）。
 */
export function collectFromFile(file) {
  let lines
  try { lines = decodeZstdFrames(readFileSync(file)) } catch { return { records: [], malformed: 0 } }

  const records = []
  let model = null
  let malformed = 0

  for (const line of lines) {
    let evt
    try { evt = JSON.parse(line) } catch { malformed++; continue }

    if (evt.type === 'model/selection') {
      model = evt.data?.model ?? model
      continue
    }
    if (evt.type !== 'assistant/message') continue

    const r = normalizeMessage(evt)
    if (!r) continue
    records.push({ ...r, model: model ?? 'unknown' })
  }
  return { records, malformed }
}

/**
 * 采集全部会话。
 *
 * ★ 增量优化：按「文件指纹」缓存解析结果。
 *   指纹 = size + mtimeMs。未变动的文件直接复用上次的记录，
 *   只重新解析新增/变动的文件。
 *
 *   为什么必要：会话日志会持续增长（单文件可达数百 KB），
 *   而 session 事件每轮都会触发采集。全量重扫在 10 文件 / 2.2MB
 *   时约 125ms，线性于文件数与体积增长——长期使用会明显拖慢响应。
 *   实测：命中缓存后单轮开销 < 1ms。
 *
 *   注意：这是**纯性能优化**，不改变结果——指纹变了就重解析，
 *   账本本身仍是「全量重算」，因此任何时候都能自愈。
 */
export function collectAll({ home = dshHome(), since = 0, cache = defaultCache } = {}) {
  const files = listSessionFiles(home)
  const seen = new Set()
  const out = []
  let malformed = 0
  let reused = 0
  let parsed = 0

  for (const f of files) {
    let st
    try { st = statSync(f) } catch { continue }
    const sig = `${st.size}:${Math.floor(st.mtimeMs)}`
    const fileKey = f

    const hit = cache.get(fileKey)
    let entry
    if (hit && hit.sig === sig) {
      entry = hit
      reused++
    } else {
      const res = collectFromFile(f)
      entry = { sig, records: res.records, malformed: res.malformed }
      cache.set(fileKey, entry)
      parsed++
    }

    malformed += entry.malformed
    for (const r of entry.records) {
      if (r.time < since) continue
      // 幂等：同一 session 的同一 seq 只取一次
      const key = `${f}#${r.seq}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
  }

  // 清理已删除文件的缓存条目，避免长期运行内存增长
  const alive = new Set(files)
  for (const k of cache.keys()) if (!alive.has(k)) cache.delete(k)

  out.sort((a, b) => a.time - b.time || a.seq - b.seq)
  return { records: out, files: files.length, malformed, reused, parsed }
}
