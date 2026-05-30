import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
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

/**
 * Find the prompts/ directory by ascending from this module's location until a
 * `prompts/system-prompt.md` is found. This is layout-independent on purpose:
 * the module ships at different depths depending on the build (vitest runs
 * `src/shell/`, tsc emits `build/shell/`, ncc bundles a flat `dist/`), so a
 * fixed relative climb breaks in at least one of them.
 */
function defaultPromptsDir(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  const root = parse(dir).root;
  for (;;) {
    const candidate = join(dir, 'prompts');
    if (existsSync(join(candidate, 'system-prompt.md'))) {
      return candidate;
    }
    if (dir === root) {
      throw new Error('找不到 prompts/ 目录（缺少 system-prompt.md）。');
    }
    dir = dirname(dir);
  }
}
