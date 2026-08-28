#!/usr/bin/env node
/**
 * dsh-subagent-router: inject.mjs — 一键给 agent-presets 的
 * tool-subagent / tool-subagent-fork 注入 agentOptions（子代理专用 LLM）。
 *
 * 用法：
 *   node scripts/inject.mjs                          # 自动探测 agent.cordis.yml
 *   node scripts/inject.mjs --file <path>            # 指定文件
 *   node scripts/inject.mjs --provider openrouter --model stealth/ox-alpha
 *   node scripts/inject.mjs --force                  # 覆盖已有注入
 *   node scripts/inject.mjs --dry-run                # 只报告不写入
 *
 * 幂等：已注入则跳过（--force 覆盖）；仅在确有修改时备份（保留最近 5 份）。
 * 只修改 subagent 工具的 config，不影响主代理路由。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const TOOL_IDS = ['tool-subagent', 'tool-subagent-fork']
const BACKUP_KEEP = 5

function parseArgs(argv) {
  const args = { provider: 'openrouter', model: 'stealth/ox-alpha', file: null, force: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i]
    else if (argv[i] === '--provider') args.provider = argv[++i]
    else if (argv[i] === '--model') args.model = argv[++i]
    else if (argv[i] === '--force') args.force = true
    else if (argv[i] === '--dry-run') args.dryRun = true
    else { console.error(`❌ 未知参数: ${argv[i]}`); process.exit(1) }
  }
  return args
}

/** 自动探测 agent.cordis.yml（standard 预设） */
function detectPresetFile() {
  const candidates = [
    process.env.DSH_PRESET_FILE,
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'agent.cordis.yml'),
    join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'agent.cordis.yml'),
    join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'agent.cordis.yml'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

/**
 * 按行扫描提取 - id: <toolId> 的块（到下一个顶格 "- id:" 或 EOF）。
 * 返回 { start, end, body }；未找到返回 null。
 * 导出供测试复用。
 */
export function findBlock(lines, toolId) {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*- id:\s*(\S+)/)
    if (m) {
      if (m[1] === toolId) { start = i; continue }
      if (start >= 0) return { start, end: i, body: lines.slice(start, i).join('\n') }
    }
  }
  if (start >= 0) return { start, end: lines.length, body: lines.slice(start).join('\n') }
  return null
}

/** 备份轮转：保留最近 BACKUP_KEEP 份 */
function rotateBackups(file) {
  const dir = dirname(file)
  const base = file.split(/[\\/]/).pop()
  const baks = readdirSync(dir)
    .filter((n) => n.startsWith(`${base}.bak-`))
    .sort()
  while (baks.length >= BACKUP_KEEP) {
    const oldest = baks.shift()
    try { unlinkSync(join(dir, oldest)) } catch { /* 忽略 */ }
  }
}

export function inject(file, provider, model, opts = {}) {
  const { force = false, dryRun = false } = opts
  const original = readFileSync(file, 'utf8')
  const lines = original.split('\n')
  let injected = 0
  let skipped = 0
  let needsWrite = false
  let next = lines

  for (const id of TOOL_IDS) {
    const block = findBlock(next, id)
    if (!block) { console.log(`  ⚠️ 未找到 ${id} 块，跳过`); continue }

    const body = block.body
    const hasAgentOptions = body.includes('agentOptions:')

    if (hasAgentOptions && !force) {
      console.log(`  ⏭️  ${id} 已注入 agentOptions（--force 可覆盖），跳过`)
      skipped++
      continue
    }
    if (hasAgentOptions && force) {
      // 覆盖：重写 agentOptions 块（provider/model 行），保留其他字段
      const out = []
      let replaced = false
      for (const line of body.split('\n')) {
        if (!replaced && /^\s*agentOptions:/.test(line)) {
          const indent = line.match(/^\s*/)[0]
          out.push(`${indent}agentOptions:`, `${indent}  provider: ${provider}`, `${indent}  model: ${model}`)
          replaced = true
          continue
        }
        if (replaced && /^\s*provider:|^\s*model:/.test(line)) continue // 跳过旧值行
        if (replaced && /^\S/.test(line)) replaced = false // 块尾（顶格行）
        out.push(line)
      }
      if (!replaced) {
        console.log(`  ❌ ${id} 的 agentOptions 结构异常，覆盖失败（请手动检查）`)
        continue
      }
      next = [
        ...next.slice(0, block.start),
        ...out,
        ...next.slice(block.end),
      ]
      console.log(`  🔄 ${id} 将覆盖 agentOptions: ${provider}/${model}${dryRun ? '（dry-run）' : ''}`)
      injected++
      needsWrite = true
      continue
    }
    // 注入：在 backgroundMode: continuable 行后插入
    const bodyLines = block.body.split('\n')
    const bmIdx = bodyLines.findIndex((l) => /^\s*backgroundMode: continuable/.test(l))
    if (bmIdx < 0) { console.log(`  ⚠️ ${id} 未找到 backgroundMode: continuable，跳过`); continue }
    const indent = bodyLines[bmIdx].match(/^\s*/)[0]
    const subIndent = indent + '  '
    const insertLines = [
      `${indent}agentOptions:`,
      `${subIndent}provider: ${provider}`,
      `${subIndent}model: ${model}`,
    ]
    next = [
      ...next.slice(0, block.start + bmIdx + 1),
      ...insertLines,
      ...next.slice(block.start + bmIdx + 1),
    ]
    console.log(`  ✅ ${id} 将注入 agentOptions: ${provider}/${model}${dryRun ? '（dry-run）' : ''}`)
    injected++
    needsWrite = true
  }

  if (!needsWrite) return { injected, skipped, written: false }

  if (dryRun) return { injected, skipped, written: false, dryRun: true }

  const result = next.join('\n')
  if (result === original) {
    console.log('  ⏭️  内容无变化，跳过写入')
    return { injected, skipped, written: false }
  }
  // 确有修改才备份
  const backup = `${file}.bak-${Date.now()}`
  copyFileSync(file, backup)
  rotateBackups(file)
  writeFileSync(file, result, 'utf8')
  return { injected, skipped, written: true, backup }
}

// CLI 入口（与 import 复用区分：pathToFileURL 精确匹配）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2))
  const file = args.file || detectPresetFile()
  if (!file) {
    console.error('❌ 未找到 agent.cordis.yml，请用 --file 指定路径（或设置 DSH_PRESET_FILE）')
    process.exit(1)
  }
  console.log(`📄 目标: ${file}`)
  const result = inject(file, args.provider, args.model, { force: args.force, dryRun: args.dryRun })
  console.log(`\n完成：注入 ${result.injected} 处，跳过 ${result.skipped} 处`)
  if (result.written) console.log(`💾 备份: ${result.backup}`)
  if (result.dryRun) console.log('（dry-run 模式，未写入任何文件）')
  if (result.written) console.log('⚠️ 修改后必须重启 dsh 才生效')
  else if (result.injected === 0) console.log('（无改动，无需重启）')
}
