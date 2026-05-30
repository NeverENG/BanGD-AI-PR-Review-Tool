# prompts/ — BanGD 的核心智力资产

这里的内容是 BanGD 评审质量的来源（占效果约 80%），比管道代码更重要。将来核心评审模块会把这些文件加载进 Claude 的系统提示词，并对这些大块固定内容开启 **prompt caching**。

| 文件 | 作用 |
|---|---|
| `system-prompt.md` | BanGD 的人设、与通用评审者的区别、工作方式、输出格式（**每次都加载**） |
| `rubric/<维度>.md` | 按维度拆分的评审清单片段，**渐进式披露**：只加载与本 PR 相关的维度 |
| `examples/` | few-shot 范例，按维度映射（见 `src/core/dimensions.ts`），随相关维度一起加载 |

## 渐进式披露（省 token + 保质量）

整份 rubric 不再每次全量塞进请求。`src/core/dimensions.ts` 是维度注册表（每个维度 → 一个 `rubric/<id>.md` 片段 + 可选的一个范例 + 启发式关键词）；`src/core/router.ts` 先用关键词从 diff/文件里**选出相关维度**，命中则只加载这些维度的片段与范例，未命中才退回 LLM 路由、再退回全量。新增维度时同时更新注册表与对应的 `rubric/<id>.md`。

## 迭代约定

- 这是**活文档**。随着评测语料集（见 CLAUDE.md）积累，根据"BanGD 建议 vs 专家评审"的差距持续修订 rubric 片段和范例。
- 新增范例时**保持维度多样性**，不要全是"双表设计"——架构级方案因问题而异（见 `examples/wal-ordering-crash-safety.md`），过拟合会降低质量。
- 每条 finding 的输出结构固定为：`问题根因 → 为什么低级解法不够 → 架构级方案 → 代价/收益`。
