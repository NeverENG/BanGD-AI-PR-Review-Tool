import { describe, it, expect, vi } from 'vitest';
import { publishReview, type ReviewPublisher, type ExistingIssue } from './publish.js';
import type { ReviewResult, Finding } from '../core/schema.js';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'cache/block.go',
    line: 12,
    severity: '阻塞',
    type: '并发',
    rootCause: 'r',
    whyLowEffortInsufficient: 'w',
    architecturalSolution: 'a',
    tradeoffs: 't',
    ...over,
  };
}

function result(findings: Finding[]): ReviewResult {
  return { changeSummary: 's', overallRisk: '高', findings };
}

function fakePublisher(over: Partial<ReviewPublisher> = {}): {
  publisher: ReviewPublisher;
  created: { title: string; body: string }[];
  comments: string[];
} {
  const created: { title: string; body: string }[] = [];
  const comments: string[] = [];
  const publisher: ReviewPublisher = {
    listExistingIssues: () => Promise.resolve([] as ExistingIssue[]),
    createIssue: (input) => {
      created.push(input);
      return Promise.resolve({ number: created.length, url: `https://x/issues/${created.length}` });
    },
    upsertSummaryComment: (body) => {
      comments.push(body);
      return Promise.resolve();
    },
    ...over,
  };
  return { publisher, created, comments };
}

describe('publishReview', () => {
  it('files one issue per fresh problem and upserts one comment', async () => {
    const { publisher, created, comments } = fakePublisher();
    const out = await publishReview(publisher, result([finding(), finding({ file: 'wal.go' })]), 42);
    expect(out.created).toBe(2);
    expect(out.reused).toBe(0);
    expect(created).toHaveLength(2);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('https://x/issues/1');
  });

  it('skips problems already filed (reuses their issue url)', async () => {
    const { publisher, created } = fakePublisher({
      listExistingIssues: () =>
        Promise.resolve([{ fullKey: 'pr42:cache/block.go:并发', url: 'https://x/issues/7' }]),
    });
    const out = await publishReview(publisher, result([finding()]), 42);
    expect(out.created).toBe(0);
    expect(out.reused).toBe(1);
    expect(created).toHaveLength(0);
  });

  it('degrades (inlines) when issue creation fails, without throwing', async () => {
    const { publisher, comments } = fakePublisher({
      createIssue: () => Promise.reject(new Error('issues disabled')),
    });
    const out = await publishReview(publisher, result([finding()]), 42);
    expect(out.degraded).toBe(true);
    expect(comments[0]).toContain('建 Issue 失败');
  });

  it('files no issues but still upserts the comment when there are no findings', async () => {
    const { publisher, created, comments } = fakePublisher();
    const upsert = vi.spyOn(publisher, 'upsertSummaryComment');
    const out = await publishReview(publisher, result([]), 42);
    expect(out.created).toBe(0);
    expect(created).toHaveLength(0);
    expect(upsert).toHaveBeenCalledOnce();
    expect(comments[0]).toContain('未发现');
  });
});
