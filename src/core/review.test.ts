import { describe, it, expect, vi } from 'vitest';
import { review, type ReviewDeps } from './review.js';
import type { LlmClient, LlmRequest, PrContext } from './ports.js';
import type { PromptTexts } from './prompt.js';
import { reviewResultJsonSchema, FindingSchema, ReviewResultSchema } from './schema.js';

const prompts: PromptTexts = {
  systemPrompt: 'SYSTEM',
  rubric: 'RUBRIC',
  examples: ['EXAMPLE_A', 'EXAMPLE_B'],
};

const SAMPLE_DIFF = [
  'diff --git a/cache/block.go b/cache/block.go',
  '--- a/cache/block.go',
  '+++ b/cache/block.go',
  '@@ -1 +1 @@',
].join('\n');

function fakePr(overrides: Partial<PrContext> = {}): PrContext {
  return {
    metadata: { title: 'add hit counter', body: 'tracks cache hits', number: 7 },
    getDiff: () => Promise.resolve(SAMPLE_DIFF),
    readFile: (path: string) =>
      Promise.resolve(path === 'cache/block.go' ? 'package cache\n// FULL FILE BODY' : null),
    ...overrides,
  };
}

const validResult = {
  changeSummary: '在块缓存读路径上新增命中计数',
  overallRisk: '高',
  findings: [
    {
      file: 'cache/block.go',
      line: 12,
      severity: '阻塞',
      type: '并发',
      rootCause: '所有权模型错误',
      whyLowEffortInsufficient: '加锁会串行化热路径',
      architecturalSolution: '读写分离的双表设计',
      tradeoffs: '实现复杂度上升，换来热路径无锁',
    },
  ],
};

function fakeLlm(output: unknown, capture?: (r: LlmRequest) => void): LlmClient {
  return {
    generateStructured: (request: LlmRequest) => {
      capture?.(request);
      return Promise.resolve(output);
    },
  };
}

describe('review (core orchestrator)', () => {
  it('returns a validated ReviewResult from the model output', async () => {
    const deps: ReviewDeps = { llm: fakeLlm(validResult), pr: fakePr() };
    const result = await review(deps, prompts);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe('并发');
    expect(result.changeSummary).toContain('命中计数');
    expect(result.overallRisk).toBe('高');
  });

  it('passes the diff and assembled prompts to the LLM', async () => {
    let seen: LlmRequest | undefined;
    const getDiff = vi.fn(() => Promise.resolve('THE_DIFF'));
    const deps: ReviewDeps = {
      llm: fakeLlm(validResult, (r) => (seen = r)),
      pr: fakePr({ getDiff }),
    };
    await review(deps, prompts);

    expect(getDiff).toHaveBeenCalledOnce();
    expect(seen?.system).toContain('SYSTEM');
    expect(seen?.system).toContain('RUBRIC');
    expect(seen?.system).toContain('EXAMPLE_A');
    expect(seen?.user).toContain('THE_DIFF');
    expect(seen?.user).toContain('add hit counter');
    expect(seen?.outputSchema).toBe(reviewResultJsonSchema);
  });

  it('reads the changed files and includes their contents in the prompt', async () => {
    let seen: LlmRequest | undefined;
    const readFile = vi.fn((path: string) =>
      Promise.resolve(path === 'cache/block.go' ? 'package cache\n// FULL FILE BODY' : null),
    );
    const deps: ReviewDeps = {
      llm: fakeLlm(validResult, (r) => (seen = r)),
      pr: fakePr({ readFile }),
    };
    await review(deps, prompts);

    expect(readFile).toHaveBeenCalledWith('cache/block.go');
    expect(seen?.user).toContain('被改动文件的完整内容');
    expect(seen?.user).toContain('FULL FILE BODY');
  });

  it('re-generates once when the first model output is malformed', async () => {
    const bad = { summary: 'x', findings: [{ file: 'a.go', severity: 'urgent' }] };
    let calls = 0;
    const llm: LlmClient = {
      generateStructured: () => {
        calls++;
        return Promise.resolve(calls === 1 ? bad : validResult);
      },
    };
    const result = await review({ llm, pr: fakePr() }, prompts);
    expect(calls).toBe(2);
    expect(result.overallRisk).toBe('高');
  });

  it('rejects when every generation violates the schema', async () => {
    const bad = { summary: 'x', findings: [{ file: 'a.go', severity: 'urgent' }] };
    const deps: ReviewDeps = { llm: fakeLlm(bad), pr: fakePr() };
    await expect(review(deps, prompts)).rejects.toThrow();
  });
});

describe('reviewResultJsonSchema', () => {
  it('stays in sync with the Zod finding keys', () => {
    const zodKeys = Object.keys(FindingSchema.shape).sort();
    const jsonKeys = Object.keys(
      reviewResultJsonSchema.properties.findings.items.properties,
    ).sort();
    expect(jsonKeys).toEqual(zodKeys);
  });

  it('lists the same required top-level keys as the Zod result', () => {
    const zodKeys = Object.keys(ReviewResultSchema.shape).sort();
    expect([...reviewResultJsonSchema.required].sort()).toEqual(zodKeys);
  });
});
