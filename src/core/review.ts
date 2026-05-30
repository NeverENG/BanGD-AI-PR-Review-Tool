import type { LlmClient, PrContext } from './ports.js';
import { assembleSystemPrompt, assembleUserPrompt, type PromptTexts } from './prompt.js';
import {
  extractChangedFiles,
  assembleFilesBlock,
  truncate,
  type LoadedFile,
} from './context.js';
import { ReviewResultSchema, reviewResultJsonSchema, type ReviewResult } from './schema.js';

/** Context budgets (chars). The diff is the primary signal and is kept (capped);
 * changed-file contents fill the remaining budget. ~chars/3-4 ≈ tokens. */
const DIFF_CHAR_CAP = 60_000;
const FILES_CHAR_BUDGET = 40_000;
const MAX_FILES_TO_READ = 40;

export interface ReviewDeps {
  llm: LlmClient;
  pr: PrContext;
}

/**
 * The trigger-agnostic core: gather context → call the LLM → validate the
 * structured result. Knows nothing about GitHub, Actions, or transport. Both
 * the Action shell and the future App shell call this with concrete ports.
 */
export async function review(deps: ReviewDeps, prompts: PromptTexts): Promise<ReviewResult> {
  const diff = await deps.pr.getDiff();

  // Read the full contents of the changed files so the model sees more than the
  // diff hunks (their untouched methods, same-file type defs, etc.).
  const changedFiles = extractChangedFiles(diff).slice(0, MAX_FILES_TO_READ);
  const loaded: LoadedFile[] = [];
  for (const path of changedFiles) {
    const content = await deps.pr.readFile(path);
    if (content !== null) loaded.push({ path, content });
  }
  const filesBlock = assembleFilesBlock(loaded, FILES_CHAR_BUDGET);

  const system = assembleSystemPrompt(prompts);
  const user = assembleUserPrompt(
    deps.pr.metadata,
    truncate(diff, DIFF_CHAR_CAP).text,
    filesBlock.text,
  );

  const raw = await deps.llm.generateStructured({
    system,
    user,
    outputSchema: reviewResultJsonSchema,
  });

  // The client returns the model's output unvalidated; the core owns the
  // validation boundary so the result is typed without `any`.
  return ReviewResultSchema.parse(raw);
}
