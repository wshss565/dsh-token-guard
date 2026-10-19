#!/usr/bin/env node
/**
 * test-runner.mjs — 跨平台测试入口
 *
 * 为什么不用「把 glob 写进命令行」的方式：
 *   带引号的 glob 在 Windows 上由 Node 内部展开，能匹配到文件；
 *   但在 Linux CI 上同一个 glob 可能被 shell 展开成字面字符串，
 *   导致「找不到任何测试文件」而失败。
 *   （实际发生：ubuntu 上 6 个 job 全红，Windows 全绿。）
 *
 * 也不用「把目录名传给 --test」：传目录在部分 Node 版本上会
 * 当成单个文件执行而失败。
 *
 * 方案：用 fs.globSync 自行展开，路径不经 shell，两平台行为一致。
 *
 * ⚠ 改这个文件时注意：注释里绝不要写 glob 字面量。
 *   双星号紧跟斜杠的写法（递归通配符）里含块注释的结束序列，
 *   会提前闭合注释，报出与实际原因无关的 SyntaxError。
 *   要举例请用中文描述，不要贴glob 原文。
 */

import { globSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ★dirname(fileURLToPath(import.meta.url)) —— 必须是 fileURLToPath 在前。
//   直接用 dirname(import.meta.url) 拿到的是 file:// URL 字符串，
//   join 之后会变成 file:///D:/... 这种路径，Node 无法当模块路径解析。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const files = globSync('test/**/*.test.mjs', { cwd: root }).sort()

if (files.length === 0) {
  console.error('未找到测试文件：test/**/*.test.mjs')
  process.exit(1)
}

const args = [
  '--test',
  '--test-timeout=30000',
  ...files.map((f) => join(root, f)),
]

const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: root })
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`测试被信号 ${signal} 终止`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
