# dsh-subagent-router

> dsh（DeepSeek Harness）子代理 LLM 路由隔离插件：让 `subagent` / `subagent_fork` 自动走独立 provider/model，**防止子代理继承主代理路由、烧掉主渠道额度**（Insufficient Balance 教训）。

## 为什么需要它

dsh 的子代理**默认继承主代理（父代理）的模型路由**。如果你在 `settings.yaml` 里配置了 `agent-default-model`，子代理会落到默认 provider——**烧的是主代理渠道的钱/额度**。

实战事故（2026-08-25）：批量任务中，子代理误走 `deepseek-official / deepseek-v4-flash`，把 DeepSeek 官方额度耗尽，出现 **Insufficient Balance** 反复崩溃（RPC 崩溃/文件锁/Reviewer 死循环）。

**本插件的核心机制**：给 `agent-presets` 的 `tool-subagent` / `tool-subagent-fork` 注入 `agentOptions`——dsh-subagent 的 `agentOptions?.provider/model ?? parent.options.*` **优先于父代理继承**，所以只有子代理走指定 LLM，主代理保持 `settings.yaml` 的默认路由。

## 安装

```bash
npm install -g @zavionwang/dsh-subagent-router
```

（或在 `cordis.patch.yml` / 插件列表中添加 `@zavionwang/dsh-subagent-router`）

## 快速开始

### 1. 一键注入（配置子代理专用 LLM）

```bash
# 自动探测 agent.cordis.yml 并注入（默认 openrouter / stealth/ox-alpha）
dsr-inject

# 自定义 provider/model
dsr-inject --provider openrouter --model stealth/ox-alpha
# 或指定文件
dsr-inject --file "C:\...\config\agent-presets\standard\agent.cordis.yml"
```

- **幂等**：已注入则跳过，可重复运行
- **安全**：注入前自动备份（`agent.cordis.yml.bak-<时间戳>`）
- 注入后**重启 dsh** 生效

### 2. 验证子代理是否真的走了独立 LLM

```bash
# 扫描 ~/.dsh/sessions 的会话记录，输出主/子代理的 provider/model 分布
dsr-verify

# 只看最近 N 个会话
dsr-verify --recent 5
```

**判定标准**（权威证据是会话记录，不是子代理自报——自报可能因 persona 误报）：

- 子代理分布中**不应出现**主渠道（如 `deepseek-official/deepseek-v4-flash`）
- 子代理应全部为配置的 provider/model（如 `openrouter/stealth/ox-alpha`）

## 配套：provider 路由与凭证

`settings.yaml` 需声明路由：

```yaml
llm-pi-ai:
  providers:
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      baseURL: https://openrouter.ai/api/v1
      models:
        - id: stealth/ox-alpha
          contextWindow: 1048576
          maxTokens: 131072
```

凭证：`.dsh/.credentials.yaml` 的 `OPENROUTER_API_KEY`（或环境变量）。

> ⚠️ OpenRouter 免费档注意：`stealth/ox-alpha` 定价 0/0，但模型 id 不含 `:free` 后缀，free tier 账户可能被限流（429/402）——这是**限流不是余额**，别误判。

## 常见问题

**Q: 改完配置为什么不生效？**
重启 dsh（配置只在新进程生效）。

**Q: 子代理自报模型不对？**
以 `dsr-verify` 的会话记录为准（自报可能因 persona 提示从 route 解析而误报）。

**Q: 会不会影响主代理？**
不会。agentOptions 只注入 subagent 工具行，主代理仍走 `settings.yaml` 的默认路由。

**Q: 报 "no adapter registered for provider" (NO_ADAPTER)？**
自定义 provider 必须声明 OpenAI 兼容协议：在 `settings.yaml` 的 provider 配置里加 `api: openai-completions`（dsh 按此选择适配器）。完整示例（智谱 GLM，实测通过）：

```yaml
llm-pi-ai:
  providers:
    zhipu:
      displayName: 智谱 GLM
      apiKeyEnv: ZHIPU_API_KEY
      api: openai-completions        # ← 必须
      baseURL: https://open.bigmodel.cn/api/paas/v4
      models:
        - id: glm-5.3-flash
          contextWindow: 131072
          maxTokens: 8192
```

> ⚠️ **YAML 缩进警告**：`providers:` 下的 provider 键必须缩进 4 空格，models 列表项 8 空格。缩进错一位会导致整个 `llm-pi-ai` 段解析失败（dsh 静默跳过，表现为 NO_ADAPTER）。改完用 `python -c "import yaml; yaml.safe_load(open('settings.yaml'))"` 校验。

**Q: GLM 免费吗？**
智谱开放平台（open.bigmodel.cn）新用户送 2000 万 tokens 体验包，`glm-5.3-flash` 为免费档模型。

## 原理

```
主代理（deepseek-official/deepseek-v4-flash）
   │  subagent/subagent_fork 调用
   ▼
tool-subagent config.agentOptions = { provider: openrouter, model: stealth/ox-alpha }
   │  dsh-subagent: agentOptions ?? parent.options
   ▼
子代理（openrouter/stealth/ox-alpha）——与主代理完全解耦
```

## License

MIT © 2026 ZavionWang
