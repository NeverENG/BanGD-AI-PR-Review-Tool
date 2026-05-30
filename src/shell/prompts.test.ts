import { describe, it, expect } from 'vitest';
import { loadPromptTexts } from './prompts.js';

describe('loadPromptTexts', () => {
  it('loads the repo prompts (system prompt, rubric, all examples)', async () => {
    const texts = await loadPromptTexts();
    expect(texts.systemPrompt).toContain('BanGD');
    expect(texts.rubric).toContain('并发');
    expect(texts.examples.length).toBeGreaterThanOrEqual(2);
    expect(texts.examples.join('\n')).toContain('双表');
  });
});
