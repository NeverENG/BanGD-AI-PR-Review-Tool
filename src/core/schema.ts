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

export const ReviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(FindingSchema),
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
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
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
          rootCause: { type: 'string' },
          whyLowEffortInsufficient: { type: 'string' },
          architecturalSolution: { type: 'string' },
          tradeoffs: { type: 'string' },
        },
      },
    },
  },
} as const;
