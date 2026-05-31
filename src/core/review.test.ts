import { describe, it, expect, vi } from 'vitest';
import { review, type ReviewDeps } from './review.js';
import type { LlmClient, LlmRequest, PrContext } from './ports.js';
import type { PromptTexts } from './prompt.js';
import { ALL_DIMENSION_IDS, type DimensionId } from './dimensions.js';
import { InvalidModelOutputError } from './errors.js';
import { RELATED_PLAN_SCHEMA } from './related.js';
import { VERDICT_SCHEMA } from './verify.js';
import { reviewResultJsonSchema, FindingSchema, GeneralFindingSchema, ReviewResultSchema } from './schema.js';

const prompts: PromptTexts = {
  systemPrompt: 'SYSTEM',
  rubric: Object.fromEntries(
    ALL_DIMENSION_IDS.map((id) => [id, `RUBRIC_${id}`]),
  ) as Record<DimensionId, string>,
  examples: { concurrency: 'EXAMPLE_CONCURRENCY', storage: 'EXAMPLE_STORAGE' },
};

// Contains a concurrency keyword (`sync.`) so the heuristic router selects the
// concurrency dimension without an LLM-fallback call.
const SAMPLE_DIFF = [
  'diff --git a/cache/block.go b/cache/block.go',
  '--- a/cache/block.go',
  '+++ b/cache/block.go',
  '@@ -1 +1 @@',
  '+\tc.hits++ // 计数, 读路径无 sync.Mutex 保护',
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

// Schema-aware fake: the related-files planner runs first (it calls with
// RELATED_PLAN_SCHEMA); by default it returns "no related files" so these tests
// exercise the review path. `output` answers the review (and LLM-router) call.
function fakeLlm(
  output: unknown,
  capture?: (r: LlmRequest) => void,
  relatedPaths: string[] = [],
): LlmClient {
  return {
    generateStructured: (request: LlmRequest) => {
      capture?.(request);
      if (request.outputSchema === RELATED_PLAN_SCHEMA) return Promise.resolve({ paths: relatedPaths });
      return Promise.resolve(output);
    },
  };
}

describe('review (core orchestrator)', () => {
  it('returns a validated ReviewResult from the model output', async () => {
    const deps: ReviewDeps = { llm: fakeLlm(validResult), pr: fakePr() };
    const { result, dimensions, relatedFiles } = await review(deps, prompts);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe('并发');
    expect(result.changeSummary).toContain('命中计数');
    expect(result.overallRisk).toBe('高');
    expect(dimensions).toContain('concurrency');
    expect(relatedFiles).toEqual([]);
  });

  it('runs adversarial verification and drops majority-refuted findings', async () => {
    const llm: LlmClient = {
      generateStructured: (request: LlmRequest) => {
        if (request.outputSchema === RELATED_PLAN_SCHEMA) return Promise.resolve({ paths: [] });
        if (request.outputSchema === VERDICT_SCHEMA) return Promise.resolve({ refuted: true, reason: 'x' });
        return Promise.resolve(validResult);
      },
    };
    const { result, droppedFindings } = await review({ llm, pr: fakePr() }, prompts, { verifyVotes: 1 });
    expect(result.findings).toHaveLength(0);
    expect(droppedFindings).toHaveLength(1);
    expect(droppedFindings[0]?.file).toBe('cache/block.go');
  });

  it('surfaces general findings and verifies them too (drops refuted ones)', async () => {
    const withGeneral = {
      ...validResult,
      generalFindings: [
        {
          file: 'cache/block.go',
          line: 20,
          severity: '重要',
          category: '边界条件',
          title: '计数溢出',
          description: 'int32 自增可能回绕',
          suggestion: '改用 int64',
        },
      ],
    };
    // Refute findings (drop), keep general findings.
    const llm: LlmClient = {
      generateStructured: (request: LlmRequest) => {
        if (request.outputSchema === RELATED_PLAN_SCHEMA) return Promise.resolve({ paths: [] });
        if (request.outputSchema === VERDICT_SCHEMA) {
          return Promise.resolve({ refuted: request.user.includes('架构级方案'), reason: 'x' });
        }
        return Promise.resolve(withGeneral);
      },
    };
    const { result, droppedFindings, droppedGeneralFindings } = await review(
      { llm, pr: fakePr() },
      prompts,
      { verifyVotes: 1 },
    );
    expect(droppedFindings).toHaveLength(1); // architecture finding refuted
    expect(droppedGeneralFindings).toHaveLength(0); // general finding kept
    expect(result.generalFindings).toHaveLength(1);
    expect(result.generalFindings[0]?.category).toBe('边界条件');
  });

  it('defaults generalFindings to [] when the model omits the field', async () => {
    const deps: ReviewDeps = { llm: fakeLlm(validResult), pr: fakePr() };
    const { result } = await review(deps, prompts);
    expect(result.generalFindings).toEqual([]);
  });

  it('sends only the selected dimension rubric + matching example', async () => {
    let seen: LlmRequest | undefined;
    const deps: ReviewDeps = {
      llm: fakeLlm(validResult, (r) => (seen = r)),
      pr: fakePr(),
    };
    const { dimensions } = await review(deps, prompts);

    expect(seen?.system).toContain('SYSTEM');
    expect(seen?.system).toContain('RUBRIC_concurrency');
    expect(seen?.system).toContain('EXAMPLE_CONCURRENCY');
    // A dimension that wasn't selected must not be included.
    expect(dimensions).not.toContain('schema');
    expect(seen?.system).not.toContain('RUBRIC_schema');
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

  it('falls back to the LLM router, then all dimensions, when heuristics miss', async () => {
    let seen: DimensionId[] = [];
    // A diff with no dimension keywords; the fake LLM returns no routing dims,
    // so selection must fall back to all dimensions.
    const deps: ReviewDeps = {
      llm: fakeLlm(validResult),
      pr: fakePr({ getDiff: () => Promise.resolve('+++ b/x.txt\n+hello world') }),
    };
    const outcome = await review(deps, prompts);
    seen = outcome.dimensions;
    expect(seen).toEqual(ALL_DIMENSION_IDS);
  });

  it('re-generates once when the first model output is malformed', async () => {
    const bad = { summary: 'x', findings: [{ file: 'a.go', severity: 'urgent' }] };
    let calls = 0;
    const llm: LlmClient = {
      generateStructured: (request: LlmRequest) => {
        if (request.outputSchema === RELATED_PLAN_SCHEMA) return Promise.resolve({ paths: [] });
        calls++;
        return Promise.resolve(calls === 1 ? bad : validResult);
      },
    };
    const { result } = await review({ llm, pr: fakePr() }, prompts);
    expect(calls).toBe(2);
    expect(result.overallRisk).toBe('高');
  });

  it('pulls planner-named related files and includes them in the prompt', async () => {
    let seen: LlmRequest | undefined;
    const readFile = vi.fn((path: string) => {
      if (path === 'cache/block.go') return Promise.resolve('package cache\n// FULL FILE BODY');
      if (path === 'cache/block_def.go') return Promise.resolve('package cache\ntype Block struct{ data []byte }');
      return Promise.resolve(null);
    });
    const deps: ReviewDeps = {
      // Planner asks for two paths; one exists, one is a miss (null, dropped).
      llm: fakeLlm(validResult, (r) => (seen = r), ['cache/block_def.go', 'cache/missing.go']),
      pr: fakePr({ readFile }),
    };
    const { relatedFiles } = await review(deps, prompts);

    expect(readFile).toHaveBeenCalledWith('cache/block_def.go');
    expect(relatedFiles).toEqual(['cache/block_def.go']);
    expect(seen?.user).toContain('周边相关代码');
    expect(seen?.user).toContain('type Block struct');
  });

  it('throws InvalidModelOutputError (carrying raw) when every generation is invalid', async () => {
    const bad = { summary: 'x', findings: [{ file: 'a.go', severity: 'urgent' }] };
    const deps: ReviewDeps = { llm: fakeLlm(bad), pr: fakePr() };
    await expect(review(deps, prompts)).rejects.toBeInstanceOf(InvalidModelOutputError);
    await review(deps, prompts).catch((e: unknown) => {
      expect(e).toBeInstanceOf(InvalidModelOutputError);
      if (e instanceof InvalidModelOutputError) expect(e.raw).toEqual(bad);
    });
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

  it('stays in sync with the Zod general-finding keys', () => {
    const zodKeys = Object.keys(GeneralFindingSchema.shape).sort();
    const jsonKeys = Object.keys(
      reviewResultJsonSchema.properties.generalFindings.items.properties,
    ).sort();
    expect(jsonKeys).toEqual(zodKeys);
  });

  it('lists the same required top-level keys as the Zod result', () => {
    const zodKeys = Object.keys(ReviewResultSchema.shape).sort();
    expect([...reviewResultJsonSchema.required].sort()).toEqual(zodKeys);
  });
});
