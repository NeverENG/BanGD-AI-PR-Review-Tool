import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PromptTexts } from '../core/prompt.js';
import { DIMENSIONS, type DimensionId } from '../core/dimensions.js';

/**
 * Loads the fixed prompt text from prompts/*. All rubric fragments and examples
 * are loaded (disk reads are free); the orchestrator decides which to actually
 * send to the model. The shell does the IO so the core stays pure/testable.
 */
export async function loadPromptTexts(promptsDir?: string): Promise<PromptTexts> {
  const dir = promptsDir ?? defaultPromptsDir();
  const systemPrompt = await readFile(join(dir, 'system-prompt.md'), 'utf8');

  const rubricEntries = await Promise.all(
    DIMENSIONS.map(async (d): Promise<[DimensionId, string]> => [
      d.id,
      await readFile(join(dir, 'rubric', `${d.id}.md`), 'utf8'),
    ]),
  );
  const rubric = Object.fromEntries(rubricEntries) as Record<DimensionId, string>;

  const examples: Partial<Record<DimensionId, string>> = {};
  await Promise.all(
    DIMENSIONS.filter((d) => d.exampleFile).map(async (d) => {
      examples[d.id] = await readFile(join(dir, 'examples', d.exampleFile as string), 'utf8');
    }),
  );

  // Always-on (not dimension-gated): the generalFindings exemplar.
  const generalExample = await readFile(join(dir, 'examples', 'general-findings.md'), 'utf8');

  return { systemPrompt, rubric, examples, generalExample };
}

/**
 * Find the prompts/ directory by ascending from this module's location until a
 * `prompts/system-prompt.md` is found. Layout-independent (vitest runs src/,
 * tsc emits build/, ncc bundles a flat dist/).
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
