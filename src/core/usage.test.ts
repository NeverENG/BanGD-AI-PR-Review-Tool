import { describe, it, expect } from 'vitest';
import { emptyUsage, addUsage, totalTokens, extractUsage, formatUsage } from './usage.js';

describe('usage accounting', () => {
  it('starts empty and totals to zero', () => {
    expect(totalTokens(emptyUsage())).toBe(0);
  });

  it('adds two usages field-by-field', () => {
    const sum = addUsage(
      { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 5 },
      { inputTokens: 1, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
    );
    expect(sum).toEqual({ inputTokens: 11, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 5 });
  });

  it('totals all input flavors plus output', () => {
    expect(
      totalTokens({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 5 }),
    ).toBe(117);
  });

  it('extracts from an Anthropic usage block, treating missing/null as 0', () => {
    expect(
      extractUsage({ input_tokens: 7, output_tokens: 4, cache_read_input_tokens: null }),
    ).toEqual({ inputTokens: 7, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(extractUsage(null)).toEqual(emptyUsage());
  });

  it('formats a readable one-liner', () => {
    const s = formatUsage({ inputTokens: 7, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(s).toContain('11 tokens');
    expect(s).toContain('输入 7');
  });
});
