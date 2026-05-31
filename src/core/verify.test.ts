import { describe, it, expect, vi } from 'vitest';
import type { LlmClient, LlmRequest } from './ports.js';
import type { Finding, GeneralFinding } from './schema.js';
import { verifyFinding, verifyFindings, verifyGeneralFindings, VERDICT_SCHEMA } from './verify.js';

function finding(file: string): Finding {
  return {
    file,
    line: 12,
    severity: '阻塞',
    type: '并发',
    rootCause: '所有权模型错误',
    whyLowEffortInsufficient: '加锁会串行化热路径',
    architecturalSolution: '读写分离的双表设计',
    tradeoffs: '实现复杂度上升',
  };
}

function generalFinding(file: string): GeneralFinding {
  return {
    file,
    line: 20,
    severity: '重要',
    category: '边界条件',
    title: '计数溢出',
    description: 'int32 自增可能回绕',
    suggestion: '改用 int64',
  };
}

const ctx = { changeSummary: '在读路径新增计数', diff: '+++ b/a.go\n+c.hits++' };

/** LLM whose every refute verdict is `refuted` (constant), capturing requests. */
function refuterLlm(refuted: boolean, capture?: (r: LlmRequest) => void): LlmClient {
  return {
    generateStructured: (r: LlmRequest) => {
      capture?.(r);
      return Promise.resolve({ refuted, reason: 'because' });
    },
  };
}

describe('verifyFinding', () => {
  it('drops on a strict majority refute (2 of 3)', async () => {
    let calls = 0;
    const llm: LlmClient = {
      generateStructured: () => {
        calls++;
        return Promise.resolve({ refuted: calls <= 2, reason: 'x' }); // 2 refute, 1 keep
      },
    };
    expect(await verifyFinding(llm, finding('a.go'), ctx, 3)).toBe(true);
  });

  it('keeps on a tie (1 of 2 refuted is not a majority)', async () => {
    let calls = 0;
    const llm: LlmClient = {
      generateStructured: () => {
        calls++;
        return Promise.resolve({ refuted: calls === 1, reason: 'x' }); // 1 refute, 1 keep
      },
    };
    expect(await verifyFinding(llm, finding('a.go'), ctx, 2)).toBe(false);
  });

  it('keeps when no refuter refutes', async () => {
    expect(await verifyFinding(refuterLlm(false), finding('a.go'), ctx, 3)).toBe(false);
  });

  it('treats a failed vote as NOT refuted (never silently suppress)', async () => {
    let calls = 0;
    const llm: LlmClient = {
      generateStructured: () => {
        calls++;
        // 1 real refute, 2 errored votes → errors count as keep → 1/3, not a majority.
        return calls === 1 ? Promise.resolve({ refuted: true, reason: 'x' }) : Promise.reject(new Error('boom'));
      },
    };
    expect(await verifyFinding(llm, finding('a.go'), ctx, 3)).toBe(false);
  });

  it('sends the verdict schema and the finding details to each refuter', async () => {
    let seen: LlmRequest | undefined;
    await verifyFinding(refuterLlm(false, (r) => (seen = r)), finding('cache/block.go'), ctx, 1);
    expect(seen?.outputSchema).toBe(VERDICT_SCHEMA);
    expect(seen?.user).toContain('cache/block.go');
    expect(seen?.user).toContain('所有权模型错误');
  });
});

describe('verifyFindings', () => {
  it('partitions findings into kept and dropped', async () => {
    // Refute only findings in b.go.
    const llm: LlmClient = {
      generateStructured: (r: LlmRequest) =>
        Promise.resolve({ refuted: r.user.includes('b.go'), reason: 'x' }),
    };
    const { kept, dropped } = await verifyFindings(llm, [finding('a.go'), finding('b.go')], ctx, 3);
    expect(kept.map((f) => f.file)).toEqual(['a.go']);
    expect(dropped.map((f) => f.file)).toEqual(['b.go']);
  });

  it('is a no-op (zero LLM calls) when votes <= 0', async () => {
    const generateStructured = vi.fn(() => Promise.resolve({ refuted: true, reason: 'x' }));
    const findings = [finding('a.go')];
    const out = await verifyFindings({ generateStructured }, findings, ctx, 0);
    expect(out).toEqual({ kept: findings, dropped: [] });
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('is a no-op when there are no findings', async () => {
    const generateStructured = vi.fn(() => Promise.resolve({ refuted: true, reason: 'x' }));
    const out = await verifyFindings({ generateStructured }, [], ctx, 3);
    expect(out).toEqual({ kept: [], dropped: [] });
    expect(generateStructured).not.toHaveBeenCalled();
  });
});

describe('verifyGeneralFindings', () => {
  it('partitions general findings by majority refute and sends their details', async () => {
    let seen: LlmRequest | undefined;
    // Refute only findings in b.go.
    const llm: LlmClient = {
      generateStructured: (r: LlmRequest) => {
        seen = r;
        return Promise.resolve({ refuted: r.user.includes('b.go'), reason: 'x' });
      },
    };
    const { kept, dropped } = await verifyGeneralFindings(
      llm,
      [generalFinding('a.go'), generalFinding('b.go')],
      ctx,
      3,
    );
    expect(kept.map((f) => f.file)).toEqual(['a.go']);
    expect(dropped.map((f) => f.file)).toEqual(['b.go']);
    // The general-finding fields reach the refuter (title/category/description).
    expect(seen?.user).toContain('计数溢出');
    expect(seen?.user).toContain('边界条件');
  });

  it('is a no-op (zero LLM calls) when votes <= 0', async () => {
    const generateStructured = vi.fn(() => Promise.resolve({ refuted: true, reason: 'x' }));
    const findings = [generalFinding('a.go')];
    const out = await verifyGeneralFindings({ generateStructured }, findings, ctx, 0);
    expect(out).toEqual({ kept: findings, dropped: [] });
    expect(generateStructured).not.toHaveBeenCalled();
  });
});
