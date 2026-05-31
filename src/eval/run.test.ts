import { describe, it, expect } from 'vitest';
import { runCleanAB, type EvalLlm } from './run.js';
import type { LlmRequest } from '../core/ports.js';
import type { PromptTexts } from '../core/prompt.js';
import type { TokenUsage } from '../core/usage.js';
import { ALL_DIMENSION_IDS, type DimensionId } from '../core/dimensions.js';
import { RELATED_PLAN_SCHEMA } from '../core/related.js';
import { VERDICT_SCHEMA } from '../core/verify.js';
import { reviewResultJsonSchema } from '../core/schema.js';
import type { EvalCase } from './corpus.js';

const prompts: PromptTexts = {
  systemPrompt: 'SYSTEM',
  rubric: Object.fromEntries(ALL_DIMENSION_IDS.map((id) => [id, `RUBRIC_${id}`])) as Record<DimensionId, string>,
  examples: { concurrency: 'EX' },
  generalExample: 'GEN',
};

// `sync.` keyword → heuristic router picks concurrency, no LLM routing call.
const DIFF = '+++ b/cache/block.go\n+\tc.hits++ // 读路径无 sync.Mutex 保护';

const evalCase: EvalCase = {
  id: 'fixture',
  source: 'NeverENG/BanDB#1',
  title: 't',
  body: 'b',
  diff: DIFF,
  expected: { findings: [{ file: 'cache/block.go', types: ['并发'] }], generalFindings: [] },
  groundTruth: 'fixture',
};

// Generation returns one true finding (cache/block.go) + one false positive (other.go).
const GENERATED = {
  changeSummary: 's',
  overallRisk: '高',
  findings: [
    { file: 'cache/block.go', line: 1, severity: '阻塞', type: '并发', rootCause: 'r', whyLowEffortInsufficient: 'w', architecturalSolution: 'a', tradeoffs: 't' },
    { file: 'other.go', line: 1, severity: '建议', type: '并发', rootCause: 'r', whyLowEffortInsufficient: 'w', architecturalSolution: 'a', tradeoffs: 't' },
  ],
  generalFindings: [],
};

function fakeLlm(usage: TokenUsage, generate: (r: LlmRequest) => unknown): EvalLlm {
  return {
    usage,
    generateStructured: (r: LlmRequest) => {
      if (r.outputSchema === RELATED_PLAN_SCHEMA) return Promise.resolve({ paths: [] });
      return Promise.resolve(generate(r));
    },
  };
}

describe('runCleanAB (clean A/B over one generation)', () => {
  it('generates ONCE and scores both configs off that single generation', async () => {
    let genCalls = 0;
    const genLlm = fakeLlm({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 }, (r) => {
      if (r.outputSchema === reviewResultJsonSchema) genCalls++;
      return GENERATED;
    });
    // Refute only the false-positive finding (other.go); keep cache/block.go.
    const verifyLlm = fakeLlm({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }, (r) => {
      if (r.outputSchema === VERDICT_SCHEMA) return { refuted: r.user.includes('other.go'), reason: 'x' };
      throw new Error('verify client should only get verdict calls');
    });

    const { baseline, optimized } = await runCleanAB([evalCase], prompts, genLlm, verifyLlm);

    // The whole point: a single generation, reused — not regenerated per config.
    expect(genCalls).toBe(1);

    // Baseline = raw findings (TP + FP). Optimized = same batch, FP refuted away.
    expect(baseline.cases[0]?.predFindings).toHaveLength(2);
    expect(optimized.cases[0]?.predFindings).toEqual([{ file: 'cache/block.go', type: '并发' }]);

    // Verification lifts precision on the SAME generation (1/2 → 1/1), recall unchanged.
    expect(baseline.findings.precision).toBeCloseTo(0.5);
    expect(optimized.findings.precision).toBeCloseTo(1);
    expect(baseline.findings.recall).toBeCloseTo(1);
    expect(optimized.findings.recall).toBeCloseTo(1);
  });

  it('attributes tokens cleanly: baseline = generation, optimized = generation + verification', async () => {
    const genLlm = fakeLlm({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 }, () => GENERATED);
    const verifyLlm = fakeLlm({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }, (r) =>
      r.outputSchema === VERDICT_SCHEMA ? { refuted: false, reason: 'x' } : null,
    );

    const { baseline, optimized } = await runCleanAB([evalCase], prompts, genLlm, verifyLlm);

    expect(baseline.tokens).toBe(110); // generation only
    expect(optimized.tokens).toBe(135); // 110 generation (shared) + 25 verification
  });

  it('records a per-case error without crashing the run, for both configs', async () => {
    const genLlm = fakeLlm({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, () => ({
      // malformed: fails Zod validation in review() → InvalidModelOutputError after retries
      nonsense: true,
    }));
    const verifyLlm = fakeLlm({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, () => ({ refuted: false, reason: 'x' }));

    const { baseline, optimized } = await runCleanAB([evalCase], prompts, genLlm, verifyLlm);

    expect(baseline.cases[0]?.error).toBeTruthy();
    expect(optimized.cases[0]?.error).toBeTruthy();
    expect(baseline.cases[0]?.predFindings).toHaveLength(0);
  });
});
