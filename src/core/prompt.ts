import type { PrMetadata } from './ports.js';
import type { DimensionId } from './dimensions.js';

/**
 * The fixed prompt text injected into the core (loaded from prompts/* by the
 * shell, never read from disk by the core itself). For progressive disclosure
 * the rubric is split per dimension and examples are keyed by dimension; the
 * orchestrator selects only the relevant ones before assembling the prompt, so
 * each request carries just the rubric fragments + examples that apply.
 */
export interface PromptTexts {
  /** prompts/system-prompt.md — always included. */
  systemPrompt: string;
  /** dimension id → prompts/rubric/<id>.md */
  rubric: Record<DimensionId, string>;
  /** dimension id → prompts/examples/<file> (only dimensions that have one) */
  examples: Partial<Record<DimensionId, string>>;
  /**
   * prompts/examples/general-findings.md — the exemplar for `generalFindings`.
   * Unlike the dimension examples this is NOT progressive-disclosure gated: it is
   * always included, because every review is asked for generalFindings. It lives
   * in the stable (prompt-cached) system block, so the marginal cost is ~nil.
   */
  generalExample: string;
}

/**
 * Assemble the system prompt from the persona + only the selected rubric
 * fragments and their matching architecture examples, plus the always-on
 * generalFindings exemplar.
 */
export function assembleSystemPrompt(
  systemPrompt: string,
  rubricFragments: string[],
  examples: string[],
  generalExample = '',
): string {
  const parts = [systemPrompt];
  if (rubricFragments.length > 0) {
    parts.push('# 评审 Rubric（仅与本 PR 相关的维度）\n\n' + rubricFragments.join('\n\n'));
  }
  if (examples.length > 0) {
    const block = examples.map((ex, i) => `## 范例 ${i + 1}\n\n${ex}`).join('\n\n');
    parts.push('# 架构级 Few-shot 范例\n\n' + block);
  }
  if (generalExample) {
    parts.push('# 普通问题 Few-shot 范例\n\n' + generalExample);
  }
  return parts.join('\n\n---\n\n');
}

export function assembleUserPrompt(
  metadata: PrMetadata,
  diff: string,
  filesText: string,
  relatedText = '',
): string {
  const sections = [
    `# 待评审的 PR`,
    `标题：${metadata.title}`,
    `描述：\n${metadata.body || '(无描述)'}`,
    `# Diff`,
    '```diff',
    diff,
    '```',
  ];
  if (filesText) {
    sections.push(
      `# 被改动文件的完整内容（用于理解 diff 之外的上下文）`,
      filesText,
    );
  }
  if (relatedText) {
    sections.push(
      `# 周边相关代码（未被改动，按需拉取，用于架构级推理）`,
      relatedText,
    );
  }
  sections.push(
    `请按系统提示词中的输出格式产出：1) PR 变更总结（changeSummary）；2) 整体风险等级（overallRisk）；3) 架构级风险识别与 Review 建议（findings）；4) 普通代码级问题（generalFindings，遵守其质量红线，没有就返回空数组）。`,
  );
  return sections.join('\n\n');
}
