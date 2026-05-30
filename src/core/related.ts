/**
 * Agentic related-code reading (DESIGN.md §六.1 — the biggest quality lever).
 *
 * Reviewing only the diff and the changed files makes BanGD miss the *untouched*
 * code that the change depends on: the struct/interface defined in another file,
 * the caller that already holds a lock, the package's other methods that share an
 * invariant. Architecture-level reasoning ("this ownership model is wrong")
 * needs that surrounding code.
 *
 * This module adds one model-directed planning round: the model names the
 * untouched files it needs (inferred from the Go imports/identifiers already
 * visible in the changed files), the core fetches them via `readFile` (bounded by
 * count + char budget; a miss is cheap — `readFile` returns null), and the result
 * is fed back into the review as extra context.
 *
 * Deliberately ONE round and reusing the single-shot `generateStructured` port —
 * not a full interleaved tool-use loop. It reuses the existing port (no redesign),
 * keeps cost bounded (one extra uncached call), and tests the hypothesis that
 * fetching related code improves the review. A multi-round / interleaved loop is a
 * later refinement once this earns its keep.
 */
import type { LlmClient } from './ports.js';
import { truncate, type LoadedFile } from './context.js';

/** JSON Schema for the planner's structured output: a list of file paths. */
export const RELATED_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['paths'],
  properties: {
    paths: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** Hard cap on how many related files one round may fetch. */
export const MAX_RELATED_FILES = 8;
/** Cap on the changed-file material handed to the planner (chars). */
const PLAN_MATERIAL_CAP = 24_000;

export interface RelatedPlanInput {
  /** The unified diff (already capped by the caller). */
  diff: string;
  /** Paths of the changed files (already loaded in full — exclude these). */
  changedFiles: string[];
  /** Full contents of the changed files, for the planner to read imports/identifiers. */
  loaded: LoadedFile[];
}

const PLANNER_SYSTEM = [
  '你是一个资深数据库内核工程师的"上下文规划助手"。',
  '下面给你一个 PR 的 diff 和被改动文件的完整内容。',
  '请判断：要在架构层面（并发/所有权/锁/内存生命周期/存储/schema 等）正确评审这个改动，',
  '还需要阅读哪些**未被改动**的周边源码文件——例如：',
  '- 被引用的 struct / interface / 常量的定义所在文件；',
  '- 持有同一把锁、或操作同一数据结构的调用方 / 被调用方；',
  '- 同一 package 内承载相同不变量的其它文件。',
  '只能依据改动代码里**已经出现**的 import 路径与标识符来推断文件路径（Go 惯例：包路径≈目录，类型名≈文件名）。',
  '规则：只返回未被改动、且确有助于评审的文件路径；不要返回已给出的被改动文件；不要臆造无依据的路径；',
  `最多返回 ${MAX_RELATED_FILES} 个；若改动是自包含的、无需额外上下文，返回空数组。`,
].join('\n');

/**
 * Ask the model which untouched related files it needs. Returns candidate paths,
 * de-duplicated, with the already-changed files removed, capped to MAX_RELATED_FILES.
 * Never throws: on any planner failure it returns [] (the review proceeds without
 * related context rather than failing).
 */
export async function planRelatedFiles(llm: LlmClient, input: RelatedPlanInput): Promise<string[]> {
  const changedSet = new Set(input.changedFiles);
  const material = input.loaded
    .map((f) => `### ${f.path}\n${f.content}`)
    .join('\n\n');
  const user = [
    '# Diff',
    '```diff',
    input.diff,
    '```',
    '# 被改动文件的完整内容',
    truncate(material, PLAN_MATERIAL_CAP).text,
    '请返回需要补充阅读的未改动文件路径（paths）。',
  ].join('\n\n');

  let raw: unknown;
  try {
    raw = await llm.generateStructured({ system: PLANNER_SYSTEM, user, outputSchema: RELATED_PLAN_SCHEMA });
  } catch {
    return [];
  }

  const paths = (raw as { paths?: unknown }).paths;
  if (!Array.isArray(paths)) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const path = p.trim().replace(/^[ab]\//, '');
    if (!path || changedSet.has(path) || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
    if (result.length >= MAX_RELATED_FILES) break;
  }
  return result;
}

/**
 * One planning round end-to-end: plan the related paths, then fetch each via
 * `readFile`, dropping misses (null). Returns the successfully read files (each
 * with its content) for inclusion in the review context.
 */
export async function gatherRelatedFiles(
  llm: LlmClient,
  readFile: (path: string) => Promise<string | null>,
  input: RelatedPlanInput,
): Promise<LoadedFile[]> {
  const paths = await planRelatedFiles(llm, input);
  const loaded: LoadedFile[] = [];
  for (const path of paths) {
    const content = await readFile(path);
    if (content !== null) loaded.push({ path, content });
  }
  return loaded;
}
