import type { ReviewResult, Finding } from '../core/schema.js';
import type { ProblemGroup } from '../core/publish.js';
import { SUMMARY_MARKER, issueKeyMarker } from './markers.js';

const SEVERITY_EMOJI: Record<Finding['severity'], string> = {
  阻塞: '🛑',
  重要: '⚠️',
  建议: '💡',
};

const RISK_EMOJI: Record<ReviewResult['overallRisk'], string> = {
  高: '🔴',
  中: '🟡',
  低: '🟢',
};

/** The four-part architecture write-up for a single finding. */
function formatFinding(f: Finding): string {
  const where = f.line === null ? f.file : `${f.file}:${f.line}`;
  return [
    `${SEVERITY_EMOJI[f.severity]} **[${f.severity} · ${f.type}] \`${where}\`**`,
    `**问题根因**：${f.rootCause}`,
    `**为什么低级解法不够**：${f.whyLowEffortInsufficient}`,
    `**架构级方案**：${f.architecturalSolution}`,
    `**代价/收益**：${f.tradeoffs}`,
  ].join('\n\n');
}

/** Title for the issue that tracks a problem group. */
export function formatIssueTitle(group: ProblemGroup): string {
  const first = group.findings[0];
  const type = first ? first.type : '架构';
  const file = first ? first.file : '';
  return `🐯 BanGD [${type}] ${file}`;
}

/** Body for the issue tracking a problem group (carries the dedup marker). */
export function formatIssueBody(group: ProblemGroup, prNumber: number): string {
  const body = group.findings.map((f) => formatFinding(f)).join('\n\n---\n\n');
  return [
    issueKeyMarker(group.fullKey),
    `> 来自 #${prNumber} 的架构级评审建议。**不阻塞合入**，仅供参考是否有更好的架构解法。`,
    body,
  ].join('\n\n');
}

export interface CommentItem {
  group: ProblemGroup;
  /** Issue URL, or null if the issue couldn't be created (inline fallback). */
  url: string | null;
}

/** The single, consolidated PR comment (architecture-level, not per-line). */
export function formatSummaryComment(
  result: ReviewResult,
  items: CommentItem[],
  footer?: string,
): string {
  const head = [
    SUMMARY_MARKER,
    '## 🐯 BanGD 数据库内核评审',
    `**整体风险**：${RISK_EMOJI[result.overallRisk]} ${result.overallRisk}`,
    `**变更总结**：${result.changeSummary}`,
    `> 本评审不阻塞合入；架构级建议以 Issue 形式跟踪。`,
  ].join('\n\n');

  const foot = footer ? `\n\n---\n\n<sub>${footer}</sub>` : '';

  if (items.length === 0) {
    return `${head}\n\n未发现需要从架构层面改进的问题。${foot}`;
  }

  const list = items
    .map((item) => {
      const first = item.group.findings[0];
      const label = first ? `[${first.type}] \`${first.file}\`` : item.group.fullKey;
      if (item.url) return `- ${label} → ${item.url}`;
      // Issue creation failed: inline the detail so the analysis isn't lost.
      const detail = item.group.findings.map((f) => formatFinding(f)).join('\n\n');
      return `- ${label}（建 Issue 失败，详情见下）\n\n${detail}`;
    })
    .join('\n');

  return `${head}\n\n### 架构问题（共 ${items.length} 项）\n\n${list}${foot}`;
}
