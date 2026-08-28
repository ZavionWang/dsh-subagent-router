import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inject, findBlock } from '../scripts/inject.mjs'

/** 构造含大写 Z（模拟 ZHIPU_API_KEY 注释）的 fixture */
function makeFixture(agentOptions = false) {
  const ao = agentOptions
    ? '        agentOptions:\n          provider: zhipu\n          model: glm-5.3-flash\n'
    : ''
  return `# preset file
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable
        # 注释含大写 Z: ZHIPU_API_KEY
${ao}
    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable
${ao}
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
`
}

function withFixture(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsr-test-'))
  const file = join(dir, 'agent.cordis.yml')
  writeFileSync(file, content, 'utf8')
  try { return fn(file, dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('findBlock: 含大写 Z 的块不被截断（回归 \Z bug）', () => {
  const lines = makeFixture().split('\n')
  const block = findBlock(lines, 'tool-subagent')
  assert.ok(block, '应找到 tool-subagent 块')
  assert.ok(block.body.includes('ZHIPU_API_KEY'), '块体应完整包含大写 Z 注释')
  assert.ok(block.body.includes('backgroundMode'), '块体应包含 backgroundMode')
  assert.ok(!block.body.includes('tool-subagent-fork'), '块不应越界到下一个工具')
})

test('findBlock: 块边界正确（不到下一个 - id:）', () => {
  const lines = makeFixture().split('\n')
  const block = findBlock(lines, 'tool-subagent')
  assert.ok(block.body.includes('provider: spawn'))
  assert.ok(!block.body.includes('tool-subagent-fork'), '不应包含下一个工具块')
})

test('inject: 未注入时写入 agentOptions（含 Z 注释场景）', () => {
  withFixture(makeFixture(false), (file) => {
    const r = inject(file, 'openrouter', 'stealth/ox-alpha')
    assert.equal(r.injected, 2)
    assert.equal(r.written, true)
    const out = readFileSync(file, 'utf8')
    assert.ok(out.includes('ZHIPU_API_KEY'), '注释保留完整')
    assert.match(out, /- id: tool-subagent[\s\S]*?agentOptions:\n\s*provider: openrouter\n\s*model: stealth\/ox-alpha/)
    assert.match(out, /- id: tool-subagent-fork[\s\S]*?agentOptions:\n\s*provider: openrouter/)
  })
})

test('inject: 幂等（已注入再跑跳过且不写文件）', () => {
  withFixture(makeFixture(true), (file) => {
    const before = readFileSync(file, 'utf8')
    const r = inject(file, 'openrouter', 'stealth/ox-alpha')
    assert.equal(r.injected, 0)
    assert.equal(r.skipped, 2)
    assert.equal(r.written, false)
    assert.equal(readFileSync(file, 'utf8'), before, '文件不应变化')
  })
})

test('inject: --force 覆盖 provider/model', () => {
  withFixture(makeFixture(true), (file) => {
    // 覆盖为不同的值（zhipu → openrouter），验证真实变化
    const r = inject(file, 'openrouter', 'stealth/ox-alpha', { force: true })
    assert.equal(r.injected, 2)
    assert.equal(r.written, true)
    const out = readFileSync(file, 'utf8')
    assert.ok(out.includes('provider: openrouter'))
    assert.ok(out.includes('model: stealth/ox-alpha'))
    assert.ok(!out.includes('model: glm-5.3-flash'), '旧值应被替换')
  })
})

test('inject: --dry-run 不写入', () => {
  withFixture(makeFixture(false), (file) => {
    const before = readFileSync(file, 'utf8')
    const r = inject(file, 'openrouter', 'stealth/ox-alpha', { dryRun: true })
    assert.equal(r.dryRun, true)
    assert.equal(readFileSync(file, 'utf8'), before)
  })
})

test('inject: 仅在修改时创建备份', () => {
  withFixture(makeFixture(false), (file) => {
    // 第一次：修改 → 有备份
    inject(file, 'openrouter', 'stealth/ox-alpha')
    const baks1 = readdirSync(join(file, '..')).filter((n) => n.includes('.bak-'))
    assert.equal(baks1.length, 1)
    // 第二次：幂等 → 无新备份
    inject(file, 'openrouter', 'stealth/ox-alpha')
    const baks2 = readdirSync(join(file, '..')).filter((n) => n.includes('.bak-'))
    assert.equal(baks2.length, 1, '幂等运行不应新增备份')
  })
})
