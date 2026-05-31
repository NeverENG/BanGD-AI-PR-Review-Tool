import { z } from 'zod';

/**
 * The shape of a single review finding. Types are inferred from these Zod
 * schemas (see `Finding`, `ReviewResult` below) so the whole pipeline is typed
 * end-to-end with no `any` at the parse boundary — the model's structured
 * output is validated through `ReviewResultSchema.parse(...)`.
 */

export const SeveritySchema = z.enum(['阻塞', '重要', '建议']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingTypeSchema = z.enum([
  '并发',
  '内存',
  '锁',
  '存储',
  'schema',
  '性能',
  '资源',
  '错误处理',
  '兼容',
]);
export type FindingType = z.infer<typeof FindingTypeSchema>;

export const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().nonnegative().nullable(),
  severity: SeveritySchema,
  type: FindingTypeSchema,
  /** Concise one-line headline of the core problem — used as the issue title.
   * Optional (cosmetic): a miss falls back to a type+file title rather than
   * sinking the whole review through a validation failure. */
  title: z.string().min(1).optional(),
  /** Root cause, not the symptom. */
  rootCause: z.string().min(1),
  /** What a generic reviewer would do, and why that is insufficient. */
  whyLowEffortInsufficient: z.string().min(1),
  /** The architecture-level fix that removes the problem by design. */
  architecturalSolution: z.string().min(1),
  /** Honest cost/benefit of the proposed solution. */
  tradeoffs: z.string().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * An *ordinary* code-level finding — the kind any competent general reviewer
 * would catch: a concrete correctness/logic bug, an off-by-one, a mishandled
 * edge case, a swallowed error at the code level. Deliberately NOT the four-段式
 * architecture write-up: these don't warrant root-cause / architectural-solution
 * reasoning, they just need to be flagged with a fix. BanGD surfaces these so it
 * also covers the general-reviewer niche, while its architecture findings remain
 * the differentiator. See DESIGN.md §一/§七.
 */
export const GeneralFindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().nonnegative().nullable(),
  severity: SeveritySchema,
  /** Short label, e.g. 逻辑错误 / 边界条件 / 错误处理 / 空指针 / 资源未释放. */
  category: z.string().min(1),
  /** One-line summary of the problem. */
  title: z.string().min(1),
  /** What is wrong and the diff evidence for it. */
  description: z.string().min(1),
  /** The ordinary (non-architectural) fix. */
  suggestion: z.string().min(1),
});
export type GeneralFinding = z.infer<typeof GeneralFindingSchema>;

export const OverallRiskSchema = z.enum(['高', '中', '低']);
export type OverallRisk = z.infer<typeof OverallRiskSchema>;

export const ReviewResultSchema = z.object({
  /** PR 变更总结：这个 PR 从数据库架构视角改了什么、动机是什么。 */
  changeSummary: z.string().min(1),
  /** 整体风险等级，用于 triage 与使用体验。 */
  overallRisk: OverallRiskSchema,
  /** 风险代码识别 + 每条的 Review 建议（架构级方案）。 */
  findings: z.array(FindingSchema),
  /** 普通代码级问题（bug/逻辑/边界等），占领通用评审生态位。默认空数组：
   * 模型遗漏该字段时不应让整条评审降级为解析失败。 */
  generalFindings: z.array(GeneralFindingSchema).default([]),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/**
 * JSON Schema mirror of `ReviewResultSchema`, used as the `input_schema` of the
 * Anthropic tool that forces structured output. Kept hand-written (rather than
 * pulling a zod→json-schema dependency) and guarded by a test that asserts it
 * stays in sync with the Zod schema's keys.
 */
export const reviewResultJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['changeSummary', 'overallRisk', 'findings', 'generalFindings'],
  properties: {
    changeSummary: { type: 'string' },
    overallRisk: { type: 'string', enum: OverallRiskSchema.options },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'file',
          'line',
          'severity',
          'type',
          'rootCause',
          'whyLowEffortInsufficient',
          'architecturalSolution',
          'tradeoffs',
        ],
        properties: {
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          severity: { type: 'string', enum: SeveritySchema.options },
          type: { type: 'string', enum: FindingTypeSchema.options },
          title: { type: 'string' },
          rootCause: { type: 'string' },
          whyLowEffortInsufficient: { type: 'string' },
          architecturalSolution: { type: 'string' },
          tradeoffs: { type: 'string' },
        },
      },
    },
    generalFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'severity', 'category', 'title', 'description', 'suggestion'],
        properties: {
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          severity: { type: 'string', enum: SeveritySchema.options },
          category: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
  },
} as const;
