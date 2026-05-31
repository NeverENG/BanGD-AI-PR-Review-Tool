import { describe, it, expect } from 'vitest';
import {
  formatSummaryComment,
  formatIssueBody,
  formatIssueTitle,
  formatDegradedComment,
  type CommentItem,
} from './format.js';
import { groupFindings } from '../core/publish.js';
import type { ReviewResult } from '../core/schema.js';
import { SUMMARY_MARKER } from './markers.js';

const finding = {
  file: 'cache/block.go',
  line: 12,
  severity: '阻塞',
  type: '并发',
  rootCause: '所有权模型错误',
  whyLowEffortInsufficient: '加锁会串行化热路径',
  architecturalSolution: '读写分离的双表设计',
  tradeoffs: '复杂度上升，换来热路径无锁',
} as const;

const result: ReviewResult = {
  changeSummary: '在读路径新增命中计数',
  overallRisk: '高',
  findings: [finding],
  generalFindings: [],
};

const generalFinding = {
  file: 'cache/block.go',
  line: 20,
  severity: '重要',
  category: '边界条件',
  title: '计数溢出未处理',
  description: 'hits 为 int32，热路径自增可能回绕',
  suggestion: '改用 int64 或饱和加法',
} as const;

describe('formatIssueBody / formatIssueTitle', () => {
  const group = groupFindings(result.findings, 42)[0]!;

  it('embeds the dedup marker and the four-part write-up', () => {
    const body = formatIssueBody(group, 42);
    expect(body).toContain('<!-- bangd-key: pr42:cache/block.go:并发 -->');
    expect(body).toContain('#42');
    expect(body).toContain('架构级方案');
    expect(body).toContain('读写分离的双表设计');
  });

  it('titles the issue with type and file', () => {
    expect(formatIssueTitle(group)).toContain('并发');
    expect(formatIssueTitle(group)).toContain('cache/block.go');
  });
});

describe('formatSummaryComment', () => {
  it('carries the summary marker, risk, change summary, and issue links', () => {
    const items: CommentItem[] = [{ group: groupFindings(result.findings, 42)[0]!, url: 'https://x/issues/9' }];
    const md = formatSummaryComment(result, items);
    expect(md).toContain(SUMMARY_MARKER);
    expect(md).toContain('整体风险');
    expect(md).toContain('在读路径新增命中计数');
    expect(md).toContain('https://x/issues/9');
    expect(md).toContain('不阻塞合入');
  });

  it('inlines the finding detail when the issue URL is null (degraded)', () => {
    const items: CommentItem[] = [{ group: groupFindings(result.findings, 42)[0]!, url: null }];
    const md = formatSummaryComment(result, items);
    expect(md).toContain('建 Issue 失败');
    expect(md).toContain('读写分离的双表设计');
  });

  it('renders a clean message with no findings', () => {
    const md = formatSummaryComment(
      { changeSummary: '小改动', overallRisk: '低', findings: [], generalFindings: [] },
      [],
    );
    expect(md).toContain('未发现需要从架构层面改进的问题');
  });

  it('lists general findings inline (with no architecture findings)', () => {
    const md = formatSummaryComment(
      { changeSummary: '小改动', overallRisk: '低', findings: [], generalFindings: [generalFinding] },
      [],
    );
    expect(md).toContain('未发现需要从架构层面改进的问题');
    expect(md).toContain('普通问题（共 1 项）');
    expect(md).toContain('边界条件');
    expect(md).toContain('计数溢出未处理');
    expect(md).toContain('改用 int64 或饱和加法');
  });

  it('renders both architecture and general sections together', () => {
    const items: CommentItem[] = [{ group: groupFindings(result.findings, 42)[0]!, url: 'https://x/issues/9' }];
    const md = formatSummaryComment({ ...result, generalFindings: [generalFinding] }, items);
    expect(md).toContain('架构问题（共 1 项）');
    expect(md).toContain('普通问题（共 1 项）');
  });

  it('omits the general section entirely when there are none', () => {
    const items: CommentItem[] = [{ group: groupFindings(result.findings, 42)[0]!, url: 'https://x/issues/9' }];
    const md = formatSummaryComment(result, items);
    expect(md).not.toContain('### 普通问题');
  });

  it('formatDegradedComment carries the marker, a non-blocking note, and the raw snippet', () => {
    const md = formatDegradedComment('RAW_OUTPUT_X');
    expect(md).toContain(SUMMARY_MARKER);
    expect(md).toContain('未能生成有效的结构化评审');
    expect(md).toContain('不阻塞合入');
    expect(md).toContain('RAW_OUTPUT_X');
  });

  it('appends the footer (e.g. token usage) when provided', () => {
    const md = formatSummaryComment(
      { changeSummary: 's', overallRisk: '低', findings: [], generalFindings: [] },
      [],
      '本次评审消耗 token：共 117 tokens',
    );
    expect(md).toContain('共 117 tokens');
  });
});
