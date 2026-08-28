#!/usr/bin/env node
/**
 * dsh-subagent-router: verify.mjs — 检查会话记录中主/子代理的 provider/model 分布，
 * 验证子代理是否真的走了指定 LLM（而不是继承主代理路由烧主渠道）。
 *
 * 用法：
 *   node scripts/verify.mjs                      # 默认扫 ~/.dsh/sessions
 *   node scripts/verify.mjs --dir <sessions目录>
 *   node scripts/verify.mjs --recent 5           # 只看最近 N 个会话文件
 *
 * 权威证据：会话记录里实际的 provider/model（子代理自报模型可能因 persona 误报）。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function parseArgs(argv) {
  const args = { dir: null, recent: 0 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i]
    else if (argv[i] === '--recent') args.recent = parseInt(argv[++i], 10) || 0
  }
  return args
}

function sessionsDir() {
  return join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'sessions')
}

/** 递归收集会话文件（session.jsonl / session.jsonl.zstd） */
function collectSessionFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/session\.jsonl(\.zstd)?$/.test(entry.name)) out.push(p)
    }
  }
  walk(root)
  return out
}

/** 读取会话文件（zstd 用 python zstandard 解压，明文直接读） */
function readSessionFile(file) {
  if (file.endsWith('.zstd')) {
    const r = spawnSync('python', ['-c',
      'import sys,zstandard;dctx=zstandard.ZstdDecompressor();\nwith dctx.stream_reader(sys.stdin.buffer) as r:\n    sys.stdout.buffer.write(r.read())',
    ], { input: readFileSync(file), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (r.status !== 0) {
      throw new Error(`zstd 解压失败（${file}）：${(r.stderr || '').slice(0, 200)}——请 pip install zstandard`)
    }
    return r.stdout
  }
  return readFileSync(file, 'utf8')
}

export function analyze(sessionDir, recent = 0) {
  if (!existsSync(sessionDir)) {
    return { error: `会话目录不存在: ${sessionDir}` }
  }
  const files = collectSessionFiles(sessionDir)
    .map((p) => ({ name: p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  const picked = recent > 0 ? files.slice(0, recent) : files
  if (picked.length === 0) return { error: `会话目录为空: ${sessionDir}` }

  const stats = new Map() // key: provider/model -> count
  const subAgentStats = new Map() // 子代理（delegationDepth>0 的会话）的分布
  let totalLines = 0

  for (const f of picked) {
    const content = readSessionFile(f.name)
    let isSubAgent = false // 该会话是否子代理（由 session 记录的 delegationDepth 判定）
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      totalLines++
      try {
        const rec = JSON.parse(line)
        if (rec.type === 'session') {
          isSubAgent = (rec.delegationDepth ?? 0) > 0
          continue
        }
        // provider/model 来源：request/context.data、request/header.data.header.config、*.data.route
        let provider, model
        const d = rec.data
        if (d) {
          if (d.provider && d.model) { provider = d.provider; model = d.model }
          else if (d.header?.config?.provider && d.header?.config?.model) { provider = d.header.config.provider; model = d.header.config.model }
          else if (d.route?.provider && d.route?.model) { provider = d.route.provider; model = d.route.model }
        }
        if (!provider || !model) continue
        const key = `${provider}/${model}`
        stats.set(key, (stats.get(key) || 0) + 1)
        if (isSubAgent) subAgentStats.set(key, (subAgentStats.get(key) || 0) + 1)
      } catch { /* 忽略非 JSON 行 */ }
    }
  }

  return {
    sessionDir,
    files: picked.length,
    lines: totalLines,
    distribution: Object.fromEntries([...stats.entries()].sort((a, b) => b[1] - a[1])),
    subAgentDistribution: Object.fromEntries([...subAgentStats.entries()].sort((a, b) => b[1] - a[1])),
  }
}

// CLI 入口
if (process.argv[1] && import.meta.url === new URL(import.meta.url).href) {
  const args = parseArgs(process.argv.slice(2))
  const dir = args.dir || sessionsDir()
  const r = analyze(dir, args.recent)
  if (r.error) { console.error(`❌ ${r.error}`); process.exit(1) }
  console.log(`📁 会话目录: ${r.sessionDir}`)
  console.log(`📄 文件数: ${r.files} | 记录行数: ${r.lines}\n`)
  console.log('=== 全部 provider/model 分布 ===')
  for (const [k, v] of Object.entries(r.distribution)) console.log(`  ${String(v).padStart(5)}  ${k}`)
  console.log('\n=== 子代理分布（depth>0 或 subagent 角色）===')
  if (Object.keys(r.subAgentDistribution).length === 0) {
    console.log('  （未识别到子代理记录——请确认会话记录格式，或用 --recent 指定窗口）')
  }
  for (const [k, v] of Object.entries(r.subAgentDistribution)) console.log(`  ${String(v).padStart(5)}  ${k}`)
  console.log('\n💡 判断：子代理若出现 deepseek-official（主渠道）即说明路由隔离失效；应全部为配置的 provider/model')
}
