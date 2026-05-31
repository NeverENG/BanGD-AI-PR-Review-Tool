import { describe, it, expect } from 'vitest';
import { loadPromptTexts } from './prompts.js';
import { ALL_DIMENSION_IDS, DIMENSIONS } from '../core/dimensions.js';

describe('loadPromptTexts', () => {
  it('loads the system prompt and a rubric fragment for every dimension', async () => {
    const texts = await loadPromptTexts();
    expect(texts.systemPrompt).toContain('BanGD');
    for (const id of ALL_DIMENSION_IDS) {
      expect(texts.rubric[id]).toBeTruthy();
    }
    expect(texts.rubric.concurrency).toContain('并发');
  });

  it('loads an example for every dimension that declares one', async () => {
    const texts = await loadPromptTexts();
    for (const d of DIMENSIONS) {
      if (d.exampleFile) expect(texts.examples[d.id]).toBeTruthy();
    }
    expect(texts.examples.concurrency).toContain('双表');
    expect(texts.examples.schema).toContain('影子表');
  });

  it('always loads the generalFindings exemplar (not dimension-gated)', async () => {
    const texts = await loadPromptTexts();
    expect(texts.generalExample).toBeTruthy();
    expect(texts.generalExample).toContain('generalFindings');
    // It must teach the red-line (what NOT to report), not just the happy path.
    expect(texts.generalExample).toContain('绝不要');
  });
});
