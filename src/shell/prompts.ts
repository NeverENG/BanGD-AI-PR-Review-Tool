import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PromptTexts } from '../core/prompt.js';

/**
 * Loads the fixed prompt text from prompts/*.md. The shell does this (not the
 * core) so the core stays pure and unit-testable. `promptsDir` defaults to the
 * repo's prompts/ directory relative to this compiled file.
 */
export async function loadPromptTexts(promptsDir?: string): Promise<PromptTexts> {
  const dir = promptsDir ?? defaultPromptsDir();
  const [systemPrompt, rubric, examples] = await Promise.all([
    readFile(join(dir, 'system-prompt.md'), 'utf8'),
    readFile(join(dir, 'rubric.md'), 'utf8'),
    loadExamples(join(dir, 'examples')),
  ]);
  return { systemPrompt, rubric, examples };
}

async function loadExamples(examplesDir: string): Promise<string[]> {
  const entries = await readdir(examplesDir);
  const files = entries.filter((name) => name.endsWith('.md')).sort();
  return Promise.all(files.map((name) => readFile(join(examplesDir, name), 'utf8')));
}

function defaultPromptsDir(): string {
  // Compiled to build/shell/prompts.js; prompts/ lives at the repo root.
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', '..', 'prompts');
}
