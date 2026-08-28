#!/usr/bin/env node
/**
 * dsh-subagent-router: inject.mjs — 一键给 agent-presets 的
 * tool-subagent / tool-subagent-fork 注入 agentOptions（子代理专用 LLM）。
 *
 * 用法：
 *   node scripts/inject.mjs                          # 自动探测 agent.cordis.yml
 *   node scripts/inject.mjs --file <path>            # 指定文件
 *   node scripts/inject.mjs --provider openrouter --model stealth/ox-alpha
 *
 * 幂等：已注入则跳过；注入前自动备份。只修改 subagent 工具的 config，
 * 不影响主代理路由（dsh-subagent 的 agentOptions 优先于父代理继承）。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const args = { provider: 'openrouter', model: 'stealth/ox-alpha', file: null, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i]
    else if (argv[i] === '--provider') args.provider = argv[++i]
    else if (argv[i] === '--model') args.model = argv[++i]
    else if (argv[i] === '--force') args.force = true
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

const TOOL_IDS = ['tool-subagent', 'tool-subagent-fork']

export function inject(file, provider, model, force = false) {
  let injected = 0
  let skipped = 0

  for (const id of TOOL_IDS) {
    // 每次循环重新读文件（上一次写入后内容已变）
    const current = readFileSync(file, 'utf8')
    // 定位 - id: <tool> 的块（到下一个顶格 "- id:" 为止）
    const blockRe = new RegExp(`(^\\s*- id: ${id}\\n[\\s\\S]*?)(?=^\\s*- id: |\\Z)`, 'm')
    const block = current.match(blockRe)
    if (!block) { console.log(`  ⚠️ 未找到 ${id} 块，跳过`); continue }

    const [full, body] = block
    if (body.includes('agentOptions:') && !force) {
      console.log(`  ⏭️  ${id} 已注入 agentOptions（--force 可覆盖），跳过`)
      skipped++
      continue
    }
    if (body.includes('agentOptions:') && force) {
      // 覆盖模式：替换已有 agentOptions 块
      const replaced = body.replace(
        /(\n\s*agentOptions:)(\n\s*provider: [^\n]*\n\s*model: [^\n]*)/,
        `$1\n${body.match(/^(\s*)agentOptions:/m)[1]}  provider: ${provider}\n${body.match(/^(\s*)agentOptions:/m)[1]}  model: ${model}`
      )
      writeFileSync(file, current.replace(full, replaced), 'utf8')
      console.log(`  🔄 ${id} 已覆盖 agentOptions: ${provider}/${model}`)
      injected++
      continue
    }
    // 在 backgroundMode: continuable 行后插入（保持缩进风格）
    const indentMatch = body.match(/^(\s*)backgroundMode: continuable/m)
    if (!indentMatch) { console.log(`  ⚠️ ${id} 未找到 backgroundMode: continuable，跳过`); continue }
    const indent = indentMatch[1]
    const subIndent = indent + '  '
    const agentOptionsBlock =
      `${indent}agentOptions:\n` +
      `${subIndent}provider: ${provider}\n` +
      `${subIndent}model: ${model}\n`
    const updated = body.replace(
      /(\n\s*backgroundMode: continuable)/,
      `$1\n${agentOptionsBlock}`
    )
    writeFileSync(file, current.replace(full, updated), 'utf8')
    console.log(`  ✅ ${id} 已注入 agentOptions: ${provider}/${model}`)
    injected++
  }
  return { injected, skipped }
}

// CLI 入口
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2))
  const file = args.file || detectPresetFile()
  if (!file) {
    console.error('❌ 未找到 agent.cordis.yml，请用 --file 指定路径（或设置 DSH_PRESET_FILE）')
    process.exit(1)
  }
  console.log(`📄 目标: ${file}`)
  const backup = `${file}.bak-${Date.now()}`
  copyFileSync(file, backup)
  console.log(`💾 备份: ${backup}`)
  const result = inject(file, args.provider, args.model, args.force)
  console.log(`\n完成：注入 ${result.injected} 处，跳过 ${result.skipped} 处`)
  console.log('⚠️ 修改后必须重启 dsh 才生效')
}
