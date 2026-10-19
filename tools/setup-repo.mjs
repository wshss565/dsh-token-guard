/**
 * setup-repo.mjs — 一键配置 GitHub 远程仓库并推送
 *
 * 用法：
 *   node tools/setup-repo.mjs <github-用户名>
 *   node tools/setup-repo.mjs <github-用户名> --dry-run   # 只预览不推送
 *
 * 做四件事：
 *   1. 填 package.json 的 repository / bugs / homepage（避免留占位地址）
 *   2. 设置 git remote origin
 *   3. 提交元数据变更
 *   4. 推送 main 分支并打 tag
 *
 * 前置：本地已装 git，且已配置好 GitHub 认证
 *（HTTPS + PAT，或 SSH key，gh CLI 非必需）。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const user = args.find((a) => !a.startsWith('--'))

if (!user) {
  console.log(`用法：node tools/setup-repo.mjs <github-用户名> [--dry-run]

示例：
  node tools/setup-repo.mjs octocat
  node tools/setup-repo.mjs octocat --dry-run`)
  process.exit(1)
}

if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(user)) {
  console.error(`"${user}" 不像合法的 GitHub 用户名`)
  process.exit(1)
}

const REPO = 'dsh-token-guard'
const REMOTE = `https://github.com/${user}/${REPO}.git`
const TAG = 'v0.4.0'

const run = (cmd, argv, opts = {}) => {
  if (dryRun) { console.log(`  [dry-run] ${cmd} ${argv.join(' ')}`); return '' }
  return execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', ...opts }).trim()
}

console.log(`配置仓库：${user}/${REPO}\n`)

// ── 1. package.json 元数据 ──
console.log('1/5  package.json 元数据')
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.repository = { type: 'git', url: `https://github.com/${user}/${REPO}.git` }
pkg.bugs = { url: `https://github.com/${user}/${REPO}/issues` }
pkg.homepage = `https://github.com/${user}/${REPO}#readme`

if (dryRun) {
  const _n = (readFileSync(join(root, 'README.md'), 'utf8').match(/your-name/g) ?? []).length
  console.log('  [dry-run] 写入 repository/bugs/homepage')
  console.log(`  [dry-run] 替换 README 中 ${_n} 处 your-name`)
} else {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log(`  ✓ repository: ${pkg.repository.url}`)

  // README 里的 CI 徽章也要替换，否则指向不存在的仓库
  const readmePath = join(root, 'README.md')
  let readme = readFileSync(readmePath, 'utf8')
  const n = (readme.match(/your-name/g) ?? []).length
  readme = readme.split('your-name').join(user)
  readme = readme.replace(/\n<!--[^\n]*徽章地址里[^\n]*-->\n/, '\n')
  writeFileSync(readmePath, readme, 'utf8')
  console.log(`  ✓ README 徽章已替换 ${n} 处`)
}

// ── 2. remote ──
console.log('\n2/5  git remote')
const remotes = run('git', ['remote']).split('\n').filter(Boolean)
if (remotes.includes('origin')) {
  run('git', ['remote', 'set-url', 'origin', REMOTE])
  console.log(`  ✓ origin 已更新为 ${REMOTE}`)
} else {
  run('git', ['remote', 'add', 'origin', REMOTE])
  console.log(`  ✓ origin = ${REMOTE}`)
}

// ── 3. 提交 ──
console.log('\n3/5  提交元数据')
if (dryRun) {
  // dry-run 下第 1 步没真写文件，status 必然为空。
  // 直接说明会提交什么，不要用 status 的结果误导。
  console.log('  [dry-run] 将提交 package.json 与 README.md')
} else {
  const status = run('git', ['status', '--porcelain'])
  if (status) {
    run('git', ['add', 'package.json', 'README.md'])
    run('git', ['commit', '-q', '-m', `chore: 指向 ${user}/${REPO}`])
    console.log('  ✓ 已提交')
  } else {
    console.log('  无变更，跳过')
  }
}

// ── 4. 推送 ──
console.log('\n4/5  推送')
console.log(`  分支: main`)
console.log(`  标签: ${TAG}`)
if (dryRun) {
  console.log(`  [dry-run] git push -u origin main`)
  console.log(`  [dry-run] git push origin ${TAG}`)
} else {
  run('git', ['push', '-u', 'origin', 'main'])
  console.log('  ✓ main 已推送')

  // tag 已存在则跳过
  const tags = run('git', ['tag', '-l', TAG])
  if (!tags) {
    run('git', ['tag', '-a', TAG, '-m', `${REPO} ${TAG}`])
    run('git', ['push', 'origin', TAG])
    console.log(`  ✓ 标签 ${TAG} 已推送`)
  } else {
    console.log(`  标签 ${TAG} 已存在，跳过`)
  }
}

console.log('\n5/5  发布后手动检查')
console.log(`  1. 打开 https://github.com/${user}/${REPO}`)
console.log('  2. 在 About 里打 topic：dsh-plugin')
console.log('     （官方靠这个标签做插件发现，漏了等于没发布）')
console.log('  3. 等 Actions 首次跑完，徽章会变成绿色')
console.log('  4. 仓库描述建议：')
console.log('     给 DeepSeek Harness 用的每日 token 预算管控：设上限、超阈值提醒、时段感知、超预算关闭任务')
console.log('')
console.log('如果 push 报认证错误，说明本机还没配好 GitHub 凭据：')
console.log('  · HTTPS：需配置 Personal Access Token（repo 权限）')
console.log('  · SSH：需把公钥加到 GitHub 账户的 SSH keys')
