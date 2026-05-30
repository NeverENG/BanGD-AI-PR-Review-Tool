import type { PrMetadata } from './ports.js';

/**
 * The fixed prompt text injected into the core (loaded from prompts/*.md by the
 * shell, never read from disk by the core itself — keeps the core pure and
 * testable). These three blocks are large and stable, so the shell marks them
 * as the cache breakpoint for Anthropic prompt caching; the per-PR diff is the
 * only uncached tail.
 */
export interface PromptTexts {
  /** prompts/system-prompt.md */
  systemPrompt: string;
  /** prompts/rubric.md */
  rubric: string;
  /** prompts/examples/*.md */
  examples: string[];
}

export function assembleSystemPrompt(texts: PromptTexts): string {
  const exampleBlock = texts.examples
    .map((ex, i) => `## 范例 ${i + 1}\n\n${ex}`)
    .join('\n\n');
  return [
    texts.systemPrompt,
    '# 评审 Rubric\n\n' + texts.rubric,
    '# Few-shot 范例\n\n' + exampleBlock,
  ].join('\n\n---\n\n');
}

export function assembleUserPrompt(metadata: PrMetadata, diff: string): string {
  return [
    `# 待评审的 PR`,
    `标题：${metadata.title}`,
    `描述：\n${metadata.body || '(无描述)'}`,
    `# Diff`,
    '```diff',
    diff,
    '```',
    `请按系统提示词中的输出格式产出：1) PR 变更总结（changeSummary）；2) 整体风险等级（overallRisk）；3) 逐条风险识别与 Review 建议（findings）。`,
  ].join('\n\n');
}
