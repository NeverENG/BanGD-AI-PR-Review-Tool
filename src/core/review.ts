import type { LlmClient, PrContext } from './ports.js';
import { assembleSystemPrompt, assembleUserPrompt, type PromptTexts } from './prompt.js';
import { ReviewResultSchema, reviewResultJsonSchema, type ReviewResult } from './schema.js';

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
  const system = assembleSystemPrompt(prompts);
  const user = assembleUserPrompt(deps.pr.metadata, diff);

  const raw = await deps.llm.generateStructured({
    system,
    user,
    outputSchema: reviewResultJsonSchema,
  });

  // The client returns the model's output unvalidated; the core owns the
  // validation boundary so the result is typed without `any`.
  return ReviewResultSchema.parse(raw);
}
