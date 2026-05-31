/**
 * Adversarial verification (DESIGN.md §六.3 — false-positive control / 误报控制).
 *
 * The main review optimizes for *finding* problems. Left alone, a strong model
 * still occasionally emits a plausible-but-wrong finding (mis-reads the diff,
 * over-states a non-issue as an architecture hazard). The four-段式 output format
 * filters the laziest noise, but not a confidently-argued false positive.
 *
 * So before delivery we run an independent adversarial pass: for each finding,
 * spawn N "refuters" who try to reject it. Three design choices keep this from
 * over-refuting (the first version, with a weak refuter model, deleted *every*
 * true finding — recall 100%→0%; see docs/评测报告.md):
 *   (A) keep-by-default: a refuter drops a finding only when it can cite concrete
 *       evidence it is wrong; "unsure" keeps it (never "unsure ⇒ refute").
 *   (B) perspective-diverse lenses: each refuter attacks ONE failure mode
 *       (diff-grounding / misread / can-it-happen), so N refuters decorrelate
 *       instead of echoing the same mistake (DESIGN §六.3).
 *   (C) unanimous-to-drop: a finding is dropped only if *every* refuter rejects
 *       it — a single defender keeps it. A failed/errored vote counts as NOT
 *       refuted (an API hiccup must never silently suppress a finding).
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

/**
 * (A) KEEP-by-default base. The old prompt told the refuter to default to
 * refuted=true when evidence was thin — which, on a weak refuter model, deleted
 * true findings wholesale (recall 100%→0% in docs/评测报告.md). We invert that:
 * keep unless the refuter can cite concrete evidence the finding is wrong.
 */
const ARCH_REFUTER_BASE = [
  '你是一个资深数据库内核评审「复核者」。下面是另一位评审者对某 PR 提出的一条架构级问题。',
  '**默认保留（refuted=false）。** 只有当你能在 reason 里指出**具体证据**证明它站不住脚时，才判 refuted=true。',
  '**拿不准、看得不够充分、需要更多上下文——一律 refuted=false（保留）**；绝不能因为"我没看出来"就否决。',
  '只依据给到的 diff 与变更总结判断，不要臆测 diff 之外的事实。',
].join('\n');

const GENERAL_REFUTER_BASE = [
  '你是一个资深代码评审「复核者」。下面是另一位评审者对某 PR 提出的一条普通代码级问题（bug / 逻辑 / 边界 / 错误处理等）。',
  '**默认保留（refuted=false）。** 只有当你能在 reason 里指出**具体证据**证明它不是真实缺陷时，才判 refuted=true。',
  '**拿不准一律 refuted=false（保留）。** 只依据给到的 diff 与变更总结判断，不要臆测 diff 之外的事实。',
].join('\n');

/**
 * (B) Perspective-diverse lenses. Each refuter scrutinizes ONE angle hardest but
 * still returns a *holistic* keep/refute verdict on the whole finding — NOT
 * "refute only on axis X". This is what makes unanimity (C) coherent: each lens
 * is a different way the finding could be wrong, so a blatant FP fails every
 * angle (→ unanimous → dropped) while a true finding survives keep-default on
 * all of them. Narrow per-axis refuting would instead let a one-axis FP survive
 * unanimity. The lens decorrelates the N refuters (DESIGN §六.3); the finding
 * text (user message) is identical across them.
 */
const ARCH_LENSES = [
  '重点从「diff 依据」角度审视——这条问题在本次 diff 里有没有具体落点、是否确由该改动引入；据此**综合判断它是否站得住脚**，不成立才 refuted=true（拿不准仍保留）。',
  '重点从「是否误读」角度审视——评审者是否误读了代码、把本就正确/正常的写法当成了隐患；据此**综合判断它是否站得住脚**，不成立才 refuted=true（拿不准仍保留）。',
  '重点从「能否发生」角度审视——这个隐患在该改动场景下是否真的可能触发、严重度有无被夸大；据此**综合判断它是否站得住脚**，不成立才 refuted=true（拿不准仍保留）。',
];

const GENERAL_LENSES = [
  '重点从「diff 依据」角度审视——该问题在 diff 里有无具体落点、是否确由改动引入；据此**综合判断它是否站得住脚**，不成立才 refuted=true（拿不准仍保留）。',
  '重点从「是否误读」角度审视——是否把正常/正确的代码当成了 bug；据此**综合判断它是否站得住脚**，不成立才 refuted=true（拿不准仍保留）。',
  '重点从「是否真缺陷」角度审视——该缺陷是否真的影响正确性、会被触发；据此**综合判断它是否站得住脚**，不成立才 refuted=true（拿不准仍保留）。',
];

/** Compose one refuter's system prompt: shared base + its assigned lens. */
function lensSystem(base: string, lenses: string[], i: number): string {
  return `${base}\n\n## 你的复核视角（只看这一个角度）\n${lenses[i % lenses.length]}\n\n在 reason 里用一句话给出你的判定依据。`;
}

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
 * Verify one item with `votes` perspective-diverse refuters (B). Dropped ONLY on
 * a *unanimous* refute (C): a single defender keeps the finding. This makes false
 * negatives (killing a real finding) hard to produce, which docs/评测报告.md
 * proved is the priority on imperfect refuter models. Combined with the
 * keep-by-default base (A), a finding is dropped only when *every* distinct lens
 * independently finds concrete grounds to reject it.
 */
async function verifyItem<T>(
  llm: LlmClient,
  item: T,
  ctx: VerifyContext,
  votes: number,
  base: string,
  lenses: string[],
  renderUser: RefuterUser<T>,
): Promise<boolean> {
  const user = renderUser(item, ctx);
  const verdicts = await Promise.all(
    [...Array(votes).keys()].map((i) => refuteOnce(llm, lensSystem(base, lenses, i), user)),
  );
  const refuted = verdicts.filter(Boolean).length;
  return votes > 0 && refuted === votes; // true => drop (unanimous refute)
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
  base: string,
  lenses: string[],
  renderUser: RefuterUser<T>,
): Promise<VerifyOutcome<T>> {
  if (votes <= 0 || items.length === 0) return { kept: items, dropped: [] };

  const dropFlags = await Promise.all(
    items.map((item) => verifyItem(llm, item, ctx, votes, base, lenses, renderUser)),
  );
  const kept: T[] = [];
  const dropped: T[] = [];
  items.forEach((item, i) => (dropFlags[i] ? dropped : kept).push(item));
  return { kept, dropped };
}

/** Verify one architecture-level finding (true => drop as a unanimously-refuted FP). */
export function verifyFinding(
  llm: LlmClient,
  finding: Finding,
  ctx: VerifyContext,
  votes: number,
): Promise<boolean> {
  return verifyItem(llm, finding, ctx, votes, ARCH_REFUTER_BASE, ARCH_LENSES, refuterUser);
}

/** Adversarially verify the architecture-level findings. */
export function verifyFindings(
  llm: LlmClient,
  findings: Finding[],
  ctx: VerifyContext,
  votes: number,
): Promise<VerifyOutcome<Finding>> {
  return verifyItems(llm, findings, ctx, votes, ARCH_REFUTER_BASE, ARCH_LENSES, refuterUser);
}

/** Adversarially verify the ordinary code-level findings (same unanimous rule). */
export function verifyGeneralFindings(
  llm: LlmClient,
  findings: GeneralFinding[],
  ctx: VerifyContext,
  votes: number,
): Promise<VerifyOutcome<GeneralFinding>> {
  return verifyItems(llm, findings, ctx, votes, GENERAL_REFUTER_BASE, GENERAL_LENSES, generalRefuterUser);
}
