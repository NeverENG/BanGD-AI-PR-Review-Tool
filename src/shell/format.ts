import type { ReviewResult, Finding } from '../core/schema.js';

const SEVERITY_EMOJI: Record<Finding['severity'], string> = {
  阻塞: '🛑',
  重要: '⚠️',
  建议: '💡',
};

function formatFinding(f: Finding, index: number): string {
  const where = f.line === null ? f.file : `${f.file}:${f.line}`;
  return [
    `### ${index + 1}. ${SEVERITY_EMOJI[f.severity]} [${f.severity} · ${f.type}] \`${where}\``,
    `**问题根因**：${f.rootCause}`,
    `**为什么低级解法不够**：${f.whyLowEffortInsufficient}`,
    `**架构级方案**：${f.architecturalSolution}`,
    `**代价/收益**：${f.tradeoffs}`,
  ].join('\n\n');
}

/** Render a ReviewResult as the Markdown body of a PR comment. Pure function. */
export function formatReviewComment(result: ReviewResult): string {
  const header = '## 🐯 BanGD 数据库内核评审';
  if (result.findings.length === 0) {
    return `${header}\n\n${result.summary || '未发现需要从架构层面改进的问题。'}`;
  }
  const body = result.findings.map((f, i) => formatFinding(f, i)).join('\n\n---\n\n');
  return `${header}\n\n${result.summary}\n\n---\n\n${body}`;
}
