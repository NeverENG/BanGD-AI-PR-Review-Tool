import { describe, it, expect } from 'vitest';
import { shouldUsePromptCaching } from './llm.js';

describe('shouldUsePromptCaching', () => {
  it('caches by default when talking to Anthropic directly (no baseURL)', () => {
    expect(shouldUsePromptCaching(undefined, undefined)).toBe(true);
  });

  it('disables caching for a compatible provider (baseURL set)', () => {
    expect(shouldUsePromptCaching('https://api.deepseek.com/anthropic', undefined)).toBe(false);
  });

  it('honors an explicit override over the baseURL default', () => {
    expect(shouldUsePromptCaching('https://api.deepseek.com/anthropic', true)).toBe(true);
    expect(shouldUsePromptCaching(undefined, false)).toBe(false);
  });
});
