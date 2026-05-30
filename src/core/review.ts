import type { LlmClient, PrContext } from './ports.js';
import { assembleSystemPrompt, assembleUserPrompt, type PromptTexts } from './prompt.js';
import {
  extractChangedFiles,
  assembleFilesBlock,
  truncate,
  type LoadedFile,
} from './context.js';
import { selectDimensionsHeuristic, sanitizeDimensions } from './router.js';
import { ALL_DIMENSION_IDS, DIMENSIONS, type DimensionId } from './dimensions.js';
import { withRetry } from './retry.js';
import { ReviewResultSchema, reviewResultJsonSchema, type ReviewResult } from './schema.js';

/** Context budgets (chars). The diff is the primary signal and is kept (capped);
 * changed-file contents fill the remaining budget. ~chars/3-4 ≈ tokens. */
const DIFF_CHAR_CAP = 60_000;
const FILES_CHAR_BUDGET = 40_000;
const MAX_FILES_TO_READ = 40;
const ROUTING_MATERIAL_CAP = 8_000;
/** Total tries for the generate-then-validate step (re-generate on bad output). */
const GENERATE_ATTEMPTS = 2;

const ROUTING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimensions'],
  properties: {
    dimensions: { type: 'array', items: { type: 'string', enum: ALL_DIMENSION_IDS } },
  },
} as const;

export interface ReviewDeps {
  llm: LlmClient;
  pr: PrContext;
}

export interface ReviewOutcome {
  result: ReviewResult;
  /** Which rubric dimensions were sent (for observability / token transparency). */
  dimensions: DimensionId[];
}

/**
 * The trigger-agnostic core: route → gather context → call the LLM → validate.
 * Progressive disclosure: only the relevant rubric fragments + examples are sent
 * (heuristic router, LLM fallback when nothing matches), to cut tokens while
 * keeping review quality on the dimensions that apply.
 */
export async function review(deps: ReviewDeps, prompts: PromptTexts): Promise<ReviewOutcome> {
  const diff = await deps.pr.getDiff();

  const changedFiles = extractChangedFiles(diff).slice(0, MAX_FILES_TO_READ);
  const loaded: LoadedFile[] = [];
  for (const path of changedFiles) {
    const content = await deps.pr.readFile(path);
    if (content !== null) loaded.push({ path, content });
  }
  const filesBlock = assembleFilesBlock(loaded, FILES_CHAR_BUDGET);

  const dimensions = await selectDimensions(deps.llm, diff, changedFiles, loaded);
  const rubricFragments = dimensions.map((id) => prompts.rubric[id]);
  const examples = dimensions
    .map((id) => prompts.examples[id])
    .filter((ex): ex is string => ex !== undefined);

  const system = assembleSystemPrompt(prompts.systemPrompt, rubricFragments, examples);
  const user = assembleUserPrompt(
    deps.pr.metadata,
    truncate(diff, DIFF_CHAR_CAP).text,
    filesBlock.text,
  );

  // The client returns the model's output unvalidated; the core owns the
  // validation boundary so the result is typed without `any`. Retry the whole
  // generate-then-validate step so a single malformed generation isn't fatal.
  const result = await withRetry(async () => {
    const raw = await deps.llm.generateStructured({
      system,
      user,
      outputSchema: reviewResultJsonSchema,
    });
    return ReviewResultSchema.parse(raw);
  }, GENERATE_ATTEMPTS);

  return { result, dimensions };
}

/**
 * Pick the rubric dimensions to send: heuristic first; if it matches nothing,
 * ask the LLM; if that is still empty, fall back to all dimensions (safe but
 * token-heavy — rare).
 */
async function selectDimensions(
  llm: LlmClient,
  diff: string,
  changedFiles: string[],
  loaded: LoadedFile[],
): Promise<DimensionId[]> {
  const material = [diff, changedFiles.join('\n'), ...loaded.map((f) => f.content)].join('\n');

  const heuristic = selectDimensionsHeuristic(material);
  if (heuristic.length > 0) return heuristic;

  const llmPicked = await routeWithLlm(llm, material);
  if (llmPicked.length > 0) return llmPicked;

  return ALL_DIMENSION_IDS;
}

async function routeWithLlm(llm: LlmClient, material: string): Promise<DimensionId[]> {
  const dimensionList = DIMENSIONS.map((d) => `- ${d.id}: ${d.title}`).join('\n');
  try {
    const raw = await llm.generateStructured({
      system: '你是一个分流器。根据 PR 内容，从给定维度里选出与本 PR 相关的维度 id（可多选，只返回相关的）。',
      user: `可选维度：\n${dimensionList}\n\n# PR 内容（节选）\n${truncate(material, ROUTING_MATERIAL_CAP).text}`,
      outputSchema: ROUTING_SCHEMA,
    });
    const dims = (raw as { dimensions?: unknown }).dimensions;
    return Array.isArray(dims) ? sanitizeDimensions(dims.filter((d): d is string => typeof d === 'string')) : [];
  } catch {
    return [];
  }
}
