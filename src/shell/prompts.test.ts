import { describe, it, expect } from 'vitest';
import { loadPromptTexts } from './prompts.js';
import { ALL_DIMENSION_IDS } from '../core/dimensions.js';

describe('loadPromptTexts', () => {
  it('loads the system prompt and a rubric fragment for every dimension', async () => {
    const texts = await loadPromptTexts();
    expect(texts.systemPrompt).toContain('BanGD');
    for (const id of ALL_DIMENSION_IDS) {
      expect(texts.rubric[id]).toBeTruthy();
    }
    expect(texts.rubric.concurrency).toContain('并发');
  });

  it('loads examples for the dimensions that have one', async () => {
    const texts = await loadPromptTexts();
    expect(texts.examples.concurrency).toContain('双表');
    expect(texts.examples.storage).toContain('WAL');
    // A dimension without an exemplar has no entry.
    expect(texts.examples.schema).toBeUndefined();
  });
});
