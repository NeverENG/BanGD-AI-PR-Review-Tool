import type { ReviewResult, Finding, GeneralFinding } from '../core/schema.js';
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

/** Basename of a repo path (e.g. `storage/zstorage/memtable.go` → `memtable.go`). */
function baseName(file: string): string {
  return file.split('/').pop() || file;
}

/** The four-part architecture write-up for a single finding. */
function formatFinding(f: Finding): string {
  const where = f.line === null ? f.file : `${f.file}:${f.line}`;
  const headline = f.title?.trim();
  const head = headline
    ? `${SEVERITY_EMOJI[f.severity]} **[${f.severity} · ${f.type}] ${headline}** \`${where}\``
    : `${SEVERITY_EMOJI[f.severity]} **[${f.severity} · ${f.type}] \`${where}\`**`;
  return [
    head,
    `**问题根因**：${f.rootCause}`,
    `**为什么低级解法不够**：${f.whyLowEffortInsufficient}`,
    `**架构级方案**：${f.architecturalSolution}`,
    `**代价/收益**：${f.tradeoffs}`,
  ].join('\n\n');
}

/**
 * One ordinary code-level finding, rendered inline in the PR comment. Unlike
 * architecture findings these are not filed as issues (they are ephemeral bug
 * flags, not tracked design problems) — just a compact one-liner + fix.
 */
function formatGeneralFinding(f: GeneralFinding): string {
  const where = f.line === null ? f.file : `${f.file}:${f.line}`;
  return [
    `${SEVERITY_EMOJI[f.severity]} **[${f.severity} · ${f.category}] \`${where}\`** ${f.title}`,
    `  - ${f.description}`,
    `  - **建议**：${f.suggestion}`,
  ].join('\n');
}

/**
 * Title for the issue that tracks a problem group. Leads with the model's
 * concise headline so the issue list reads as a list of *problems*, not just
 * type+file labels: `🐯 [并发] 读路径无同步自增 hits 计数 · memtable.go`. Falls
 * back to the old type+file form when the (optional) headline is absent.
 */
export function formatIssueTitle(group: ProblemGroup): string {
  const first = group.findings[0];
  const type = first ? first.type : '架构';
  const file = first ? first.file : '';
  const headline = first?.title?.trim();
  return headline ? `🐯 [${type}] ${headline} · ${baseName(file)}` : `🐯 BanGD [${type}] ${file}`;
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

/**
 * Comment used when the model failed to produce a valid structured review.
 * Non-blocking: tells the author it can be retried / use a stronger model, and
 * includes the raw output snippet for debugging. Carries the summary marker so
 * it upserts the single comment like a normal review.
 */
export function formatDegradedComment(rawSnippet: string): string {
  return [
    SUMMARY_MARKER,
    '## 🐯 BanGD 数据库内核评审',
    '⚠️ 本次未能生成有效的结构化评审（模型返回的内容无法解析）。**不阻塞合入**，可重试，或改用更强的模型。',
    `<details><summary>模型原始输出片段（调试用）</summary>\n\n\`\`\`\n${rawSnippet}\n\`\`\`\n</details>`,
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
    `> 本评审不阻塞合入；架构级建议以 Issue 形式跟踪，普通问题在下方内联列出。`,
  ].join('\n\n');

  const foot = footer ? `\n\n---\n\n<sub>${footer}</sub>` : '';

  const sections: string[] = [];

  if (items.length === 0) {
    sections.push('未发现需要从架构层面改进的问题。');
  } else {
    const list = items
      .map((item) => {
        const first = item.group.findings[0];
        const headline = first?.title?.trim();
        const label = first
          ? `[${first.type}] ${headline ? `${headline} ` : ''}\`${first.file}\``
          : item.group.fullKey;
        if (item.url) return `- ${label} → ${item.url}`;
        // Issue creation failed: inline the detail so the analysis isn't lost.
        const detail = item.group.findings.map((f) => formatFinding(f)).join('\n\n');
        return `- ${label}（建 Issue 失败，详情见下）\n\n${detail}`;
      })
      .join('\n');
    sections.push(`### 架构问题（共 ${items.length} 项）\n\n${list}`);
  }

  // Ordinary code-level findings (the general-reviewer niche): listed inline,
  // not filed as issues. Omitted entirely when there are none.
  const general = result.generalFindings;
  if (general.length > 0) {
    const list = general.map((f) => formatGeneralFinding(f)).join('\n\n');
    sections.push(`### 普通问题（共 ${general.length} 项）\n\n${list}`);
  }

  return `${head}\n\n${sections.join('\n\n')}${foot}`;
}
