/**
 * dsh-subagent-router — 宿主半区。
 *
 * 启动时检查 agent-presets 的 tool-subagent / tool-subagent-fork 是否已注入
 * agentOptions（子代理专用 LLM）。已注入则确认；未注入则提示用
 * `npx @zavionwang/dsh-subagent-router` 或 `node scripts/inject.mjs` 注入。
 *
 * 只读检查 + 日志提示，不自动改文件（配置注入必须显式执行，避免静默改动）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = '@zavionwang/dsh-subagent-router'

const TOOL_IDS = ['tool-subagent', 'tool-subagent-fork']

function detectPresetFile() {
  const candidates = [
    process.env.DSH_PRESET_FILE,
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'agent.cordis.yml'),
    join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'agent.cordis.yml'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

export function apply(ctx) {
  const log = (...args) => console.log('[dsh-subagent-router]', ...args)
  try {
    const file = detectPresetFile()
    if (!file) { log('未找到 agent.cordis.yml，跳过检查'); return }
    const content = readFileSync(file, 'utf8')
    const lines = content.split('\n')
    // 行级块解析：找 - id: <tool> 块（到下一个顶格 - id: 或 EOF），判断块内是否含 agentOptions
    const injected = TOOL_IDS.filter((id) => {
      let start = -1
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*- id:\s*(\S+)/)
        if (m) {
          if (m[1] === id) { start = i; continue }
          if (start >= 0) {
            return lines.slice(start, i).join('\n').includes('agentOptions:')
          }
        }
      }
      return start >= 0 && lines.slice(start).join('\n').includes('agentOptions:')
    })
    if (injected.length === TOOL_IDS.length) {
      log(`✅ 子代理路由隔离已生效（${injected.join(' / ')} 均含 agentOptions）`)
    } else if (injected.length > 0) {
      log(`⚠️ 部分注入（${injected.join(', ')}），缺失：${TOOL_IDS.filter((i) => !injected.includes(i)).join(', ')}——运行 npx @zavionwang/dsh-subagent-router 补全`)
    } else {
      log('⚠️ 子代理未配置独立 LLM（会继承主代理路由、烧主渠道额度）——运行 `npx @zavionwang/dsh-subagent-router inject` 一键注入')
    }
  } catch (e) {
    log('检查失败：', e.message)
  }
}
