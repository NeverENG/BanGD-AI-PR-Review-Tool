# BanGD — 数据库垂类 AI PR 评审助手

> 让 AI 像**资深数据库内核工程师**一样评审 PR，而不是像一个只会找语法错误的 linter。
BanGD 是面向 **BanDB 数据库引擎（Go）** 的 AI PR 评审助手。它在每个 Pull Request 上自动给出**架构层面**的评审意见——不是"这里可能有并发问题，加个锁吧"，而是"这块内存的所有权模型错了，应该用读写分离的双表设计，既消除竞争又提升吞吐"。
demo演示视频：https://www.bilibili.com/video/BV1EaVS6rEuN/?vd_source=a0576f42e09e3a525d24856e9882c44e
---

## 它解决什么问题

通用 AI 评审器（Copilot、通用 Claude review 等）在数据库内核这种垂直领域有两个致命短板：

1. **只看到症状，看不到根因。** 它们能发现"并发读写 map 会 panic"，但给出的是最低级的解法——把异步改同步、无脑加锁、用 `recover` 兜住 panic。这些"解法"往往牺牲了数据库最核心的性能，或只是把炸弹埋给下一个人。
2. **不具备领域纵深。** 它们不会从 MVCC、WAL 顺序、锁粒度、存储格式兼容性这些数据库内核的角度去质疑一处改动。

BanGD 的设计目标就是补上这两点：**识别根因 → 拒绝低级解法 → 给出从设计层面消除问题的架构级方案 → 诚实权衡代价**。

---

## 核心优势

- **架构级，而非症状级。** 每条建议强制遵循四段式结构：`问题根因 → 为什么低级解法不够 → 架构级方案 → 代价/收益`。这个结构从输出格式上就杜绝了"加个锁就完事"的敷衍答案，逼模型把分析推到根因和设计层面。

- **数据库内核垂类知识。** 内置一份覆盖 9 个维度的评审 rubric（并发、内存生命周期、锁与隔离、WAL/崩溃恢复、schema 演进、热路径性能、资源泄漏、错误处理、兼容契约），每个维度都写明"该往哪个架构方向追问"；并配有 few-shot 范例锚定点评深度。这是"垂类"能力的来源。

- **三合一产出，可直接 triage。** 一次评审同时给出：
  - **PR 变更总结**——用架构语言概括"动了系统哪一层、改了什么不变量"；
  - **整体风险等级**（🔴 高 / 🟡 中 / 🟢 低）——一眼判断要不要立刻看；
  - **逐条风险识别 + Review 建议**——带文件/行号、严重度、类型。

- **不阻塞合入，用 Issue 跟踪。** PR 上只留**一条**汇总评论（不刷屏），每个架构问题单独建一个 Issue。后续 commit 只为**新出现**的问题建 Issue，已提过的（按 `文件+问题类型`）不重复——避免每次推送都重复打扰。

- **零运维、被动触发。** 以 GitHub Action 形态运行，装一个 workflow 即可，无需任何常驻服务器。PR 一开，GitHub 自动触发评审。

- **结果可靠、可控误报。** 模型输出经 JSON Schema 强制结构化 + 运行时校验，格式幻觉在解析边界即被拒绝；每条建议都必须自带论证与权衡，用"论证成本"过滤噪音。

- **响应快、成本低。** 渐进式披露只把相关维度的 rubric/范例发给模型；大块固定内容启用 prompt caching，每个 PR 只有 diff 这条尾巴是未缓存的。

- **模型/厂商可配置。** 默认 Claude Opus（最强架构推理）；也支持任何 Anthropic 兼容端点（如 DeepSeek），方便低成本验证或私有化部署。

> 更深入的设计思路（模型选择、上下文获取方式、未来扩展方向，以及在准确性、上下文理解、误报漏报、响应速度、使用体验上的权衡）见 **[DESIGN.md](./DESIGN.md)**。

---

## 配置指南（5 分钟接入）

下面以"在 **BanDB 仓库**里启用 BanGD"为例。整个过程只需两步：**加一个 API Key Secret** + **加一个 workflow 文件**。

### 第 1 步：在仓库添加 API Key（Secret）

API Key 是敏感凭据，**绝不能写进代码或 workflow 文件**，要存到仓库的加密 Secret 里。

1. 打开 **BanDB 仓库** → 顶部 **Settings**（设置）。
2. 左侧边栏 → **Secrets and variables** → **Actions**。
3. 点击 **New repository secret**（新建仓库密钥）。
4. 填写：
   - **Name**（名称）：`ANTHROPIC_API_KEY`
   - **Secret**（值）：粘贴你的 API Key。
     - 用 Claude：填 Anthropic 的 key（`sk-ant-...`）。
     - 用 DeepSeek：填 DeepSeek 的 key（后面第 2 步还要加 `base_url` 和 `model`）。
5. 点 **Add secret** 保存。

> 之后在 workflow 里用 `${{ secrets.ANTHROPIC_API_KEY }}` 引用，GitHub 会在运行时注入，日志中自动打码，不会泄露。

### 第 2 步：添加 CI workflow 文件

在 **BanDB 仓库**里新建文件 `.github/workflows/bangd.yml`，内容如下（也可直接复制本仓库的 [`examples/bandb-workflow.yml`](./examples/bandb-workflow.yml)）：

```yaml
name: BanGD Review

on:
  pull_request:
    types: [opened, synchronize, reopened]   # 开 PR / 推新 commit / 重开 时触发

permissions:
  contents: read          # 读取 diff 和文件内容
  pull-requests: write    # 在 PR 上发一条汇总评论
  issues: write           # 每个架构问题建一个 Issue（不阻塞合入）

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: NeverENG/BanGD-AI-PR-Review-Tool@main
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ github.token }}    # GitHub 自动提供，无需自己配
          # —— 默认用 Claude Opus（生产推荐）——
          # —— 若用 DeepSeek，取消下面两行注释 ——
          # base_url: https://api.deepseek.com/anthropic
          # model: deepseek-chat
```

把它提交到默认分支（`main`）即可生效。

> **不需要 `actions/checkout`**：BanGD 通过 GitHub API 拉取 diff 和文件，并自带 prompts/ 与打包产物，不依赖把 BanDB 代码 checkout 到本地。

### 第 3 步：验证

1. 在 BanDB 仓库随便开一个 PR（或往已有 PR 推一个 commit）。
2. 打开该 PR 的 **Checks** 标签，能看到 `BanGD Review` 这个 job 在跑。
3. 跑完后，BanGD 会在 PR 上贴**一条**汇总评论（风险徽章 + 变更总结 + 指向各 Issue 的链接），并为每个架构问题建一个带 `bangd` 标签的 Issue。后续推 commit 只补新问题，不重复。

如果没触发：检查 workflow 文件在**默认分支**上、`permissions` 写了 `pull-requests: write`、Secret 名字拼写一致。

### 用 DeepSeek 临时跑（验证链路，非生产质量）

DeepSeek 提供 Anthropic 兼容端点。把第 2 步里那两行注释取消即可：

```yaml
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}   # 这里填 DeepSeek key
          base_url: https://api.deepseek.com/anthropic
          model: deepseek-chat
```

> 注意：DeepSeek 较弱，**用来验证"链路通不通"，而非"点评准不准"**。生产仍建议用 Claude Opus。

---

## Action 输入参数

| 输入 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `anthropic_api_key` | 是 | — | 调用模型的 API Key（用仓库 Secret 引用） |
| `github_token` | 是 | `${{ github.token }}` | 读 diff、发评论用，GitHub 自动提供 |
| `model` | 否 | `claude-opus-4-8` | 模型 id；DeepSeek 用 `deepseek-chat` |
| `base_url` | 否 | （Anthropic 官方） | Anthropic 兼容端点，如 `https://api.deepseek.com/anthropic` |

输出：`finding_count`（本次评审产出的 finding 数量）。

---

## 触发模型说明：为什么"不监控账号"

BanGD **不轮询、不监控任何 GitHub 账号**。在 Action 模式下，是 **GitHub 主动把 PR 事件推送**给一个临时 runner，零常驻服务。一份 workflow 管一个仓库；要覆盖多个仓库就每个仓库放一份。

若希望"按账号/组织统一监控所有仓库"而无需逐仓配置，那是未来的 **GitHub App + Webhook** 形态。由于本项目的核心逻辑与触发方式解耦，届时只需再写一层 shell 适配器，核心评审逻辑保持不变。

---

## 本地开发

```bash
npm install
npm run typecheck    # tsc --noEmit（strict）
npm run lint         # eslint（强制禁用 any）
npm test             # vitest
npm run build:action # 重新打包 dist/（改了源码后必做，Action 跑的是打包产物）
npm run smoke        # 对内置样本 diff 真实调用一次模型，验证端到端链路
```

`smoke` 读取环境变量运行，例如用 DeepSeek：

```bash
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_API_KEY=<你的 key> BANGD_MODEL=deepseek-chat \
npm run smoke
```

架构与开发约定见 **[CLAUDE.md](./CLAUDE.md)**。
