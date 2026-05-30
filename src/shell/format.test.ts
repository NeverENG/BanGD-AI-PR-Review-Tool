import { describe, it, expect } from 'vitest';
import { formatReviewComment } from './format.js';
import type { ReviewResult } from '../core/schema.js';

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

describe('formatReviewComment', () => {
  it('renders each finding with the four-part structure and location', () => {
    const result: ReviewResult = { summary: '发现一处并发隐患', findings: [finding] };
    const md = formatReviewComment(result);
    expect(md).toContain('BanGD');
    expect(md).toContain('cache/block.go:12');
    expect(md).toContain('问题根因');
    expect(md).toContain('为什么低级解法不够');
    expect(md).toContain('架构级方案');
    expect(md).toContain('代价/收益');
    expect(md).toContain('读写分离的双表设计');
  });

  it('omits the line number when line is null', () => {
    const result: ReviewResult = {
      summary: 's',
      findings: [{ ...finding, line: null }],
    };
    expect(formatReviewComment(result)).toContain('`cache/block.go`');
  });

  it('renders a clean message when there are no findings', () => {
    const md = formatReviewComment({ summary: '', findings: [] });
    expect(md).toContain('未发现需要从架构层面改进的问题');
  });
});
