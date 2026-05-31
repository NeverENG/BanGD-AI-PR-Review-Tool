/**
 * Adversarial verification (DESIGN.md §六.3 — false-positive control / 误报控制).
 *
 * The main review optimizes for *finding* problems. Left alone, a strong model
 * still occasionally emits a plausible-but-wrong finding (mis-reads the diff,
 * over-states a non-issue as an architecture hazard). The four-段式 output format
 * filters the laziest noise, but not a confidently-argued false positive.
 *
 * So before delivery we run an independent adversarial pass: for each finding,
 * spawn N "refuters" whose job is to REFUTE it — each judges, with the change
 * context, whether the finding is a genuine diff-introduced architecture hazard
 * or a false positive, defaulting to refuted when the evidence is thin. A finding
 * is dropped only on a *majority* refute, so one over-eager skeptic can't kill a
 * real finding (and a failed/errored vote counts as NOT refuted — an API hiccup
 * must never silently suppress a finding).
 *
 * Cost is bounded and opt-scaled: `votes <= 0` disables the pass entirely (zero
 * extra calls), and with no findings there is nothing to verify. The refuters run
 * concurrently.
 */
import type { LlmClient } from './ports.js';
import type { Finding, GeneralFinding } from './schema.js';
import { truncate } from './context.js';

/** JSON Schema for one refuter's verdict. */
export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
} as const;

/** Cap on the change context handed to each refuter (chars). */
const VERIFY_DIFF_CAP = 30_000;

export interface VerifyContext {
  changeSummary: string;
  diff: string;
}

export interface VerifyOutcome<T> {
  /** Items that survived the adversarial pass (majority did NOT refute). */
  kept: T[];
  /** Items dropped as likely false positives (majority refuted). */
  dropped: T[];
}

/** Renders one item into the refuter's user message (item-type specific). */
type RefuterUser<T> = (item: T, ctx: VerifyContext) => string;

const REFUTER_SYSTEM = [
  '你是一个挑剔的资深数据库内核评审「复核者」。',
  '下面是另一位评审者对某 PR 提出的一条问题。请独立、对抗式地判断：',
  '这条问题是否站得住脚——即「确实是本次 diff 引入的、真实的架构级隐患」，',
  '还是一个**误报**（无 diff 依据 / 与改动无关 / 夸大严重度 / 把正常代码误判为隐患 / 推理链断裂）。',
  '只依据给到的 diff 与变更总结判断，不要臆测 diff 之外的事实。',
  '若证据不足以确认它是一个真实的、由该 diff 引入的问题，请判为 refuted=true。',
  '在 reason 里用一句话说明你判定成立或误报的依据。',
].join('\n');

const GENERAL_REFUTER_SYSTEM = [
  '你是一个挑剔的资深代码评审「复核者」。',
  '下面是另一位评审者对某 PR 提出的一条**普通代码级问题**（bug / 逻辑 / 边界 / 错误处理等）。',
  '请独立、对抗式地判断：这条问题是否站得住脚——即「确实是本次 diff 引入或暴露的、真实的正确性/逻辑缺陷」，',
  '还是一个**误报**（无 diff 依据 / 与改动无关 / 误读代码 / 把正常写法当成 bug / 只是风格或主观偏好）。',
  '只依据给到的 diff 与变更总结判断，不要臆测 diff 之外的事实。',
  '若证据不足以确认它是一个真实的、由该 diff 引入或暴露的缺陷，请判为 refuted=true。',
  '在 reason 里用一句话说明你判定成立或误报的依据。',
].join('\n');

/** Prepends the shared change-context preamble to an item-specific tail. */
function withContext(ctx: VerifyContext, tail: string[]): string {
  return [
    '# 变更总结',
    ctx.changeSummary,
    '# Diff',
    '```diff',
    truncate(ctx.diff, VERIFY_DIFF_CAP).text,
    '```',
    '# 待复核的问题',
    ...tail,
    '请判断这条问题是否为误报（refuted）。',
  ].join('\n\n');
}

function refuterUser(finding: Finding, ctx: VerifyContext): string {
  return withContext(ctx, [
    `文件：${finding.file}${finding.line === null ? '' : `:${finding.line}`}`,
    `类型：${finding.type}｜严重度：${finding.severity}`,
    `问题根因：${finding.rootCause}`,
    `为什么低级解法不够：${finding.whyLowEffortInsufficient}`,
    `架构级方案：${finding.architecturalSolution}`,
    `代价/收益：${finding.tradeoffs}`,
  ]);
}

function generalRefuterUser(finding: GeneralFinding, ctx: VerifyContext): string {
  return withContext(ctx, [
    `文件：${finding.file}${finding.line === null ? '' : `:${finding.line}`}`,
    `类别：${finding.category}｜严重度：${finding.severity}`,
    `标题：${finding.title}`,
    `描述：${finding.description}`,
    `建议：${finding.suggestion}`,
  ]);
}

/** Run one refuter; a failed/unparseable vote counts as NOT refuted. */
async function refuteOnce(llm: LlmClient, system: string, user: string): Promise<boolean> {
  try {
    const raw = await llm.generateStructured({ system, user, outputSchema: VERDICT_SCHEMA });
    return (raw as { refuted?: unknown }).refuted === true;
  } catch {
    return false;
  }
}

/**
 * Verify one item with `votes` independent refuters. Dropped only on a strict
 * majority refute (refutedCount > votes/2), so a single skeptic can't veto a real
 * finding and a tie keeps the item.
 */
async function verifyItem<T>(
  llm: LlmClient,
  item: T,
  ctx: VerifyContext,
  votes: number,
  system: string,
  renderUser: RefuterUser<T>,
): Promise<boolean> {
  const verdicts = await Promise.all(
    Array.from({ length: votes }, () => refuteOnce(llm, system, renderUser(item, ctx))),
  );
  const refuted = verdicts.filter(Boolean).length;
  return refuted > votes / 2; // true => drop (majority refuted)
}

/**
 * Adversarially verify every item. With `votes <= 0` (or no items) this is a
 * no-op that makes zero LLM calls and keeps all items unchanged.
 */
async function verifyItems<T>(
  llm: LlmClient,
  items: T[],
  ctx: VerifyContext,
  votes: number,
  system: string,
  renderUser: RefuterUser<T>,
): Promise<VerifyOutcome<T>> {
  if (votes <= 0 || items.length === 0) return { kept: items, dropped: [] };

  const dropFlags = await Promise.all(
    items.map((item) => verifyItem(llm, item, ctx, votes, system, renderUser)),
  );
  const kept: T[] = [];
  const dropped: T[] = [];
  items.forEach((item, i) => (dropFlags[i] ? dropped : kept).push(item));
  return { kept, dropped };
}

/** Verify one architecture-level finding (true => drop as a majority-refuted FP). */
export function verifyFinding(
  llm: LlmClient,
  finding: Finding,
  ctx: VerifyContext,
  votes: number,
): Promise<boolean> {
  return verifyItem(llm, finding, ctx, votes, REFUTER_SYSTEM, refuterUser);
}

/** Adversarially verify the architecture-level findings. */
export function verifyFindings(
  llm: LlmClient,
  findings: Finding[],
  ctx: VerifyContext,
  votes: number,
): Promise<VerifyOutcome<Finding>> {
  return verifyItems(llm, findings, ctx, votes, REFUTER_SYSTEM, refuterUser);
}

/** Adversarially verify the ordinary code-level findings (same majority rule). */
export function verifyGeneralFindings(
  llm: LlmClient,
  findings: GeneralFinding[],
  ctx: VerifyContext,
  votes: number,
): Promise<VerifyOutcome<GeneralFinding>> {
  return verifyItems(llm, findings, ctx, votes, GENERAL_REFUTER_SYSTEM, generalRefuterUser);
}
