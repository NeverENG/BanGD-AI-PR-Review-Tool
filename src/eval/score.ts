/**
 * Evaluation scoring (DESIGN.md §六.2 — 评测语料集).
 *
 * Given a labeled corpus (each case carries the findings a competent reviewer
 * SHOULD surface) and BanGD's actual output, compute precision / recall / F1.
 * The matching is deliberately *fuzzy and documented*: a finding is inherently a
 * judgement, so we match on the structural anchors we trust — the file plus an
 * accepted set of types/categories — not on exact prose. This keeps the metric
 * honest (it can't be gamed by wording) and reproducible.
 *
 * Pure and side-effect-free, so the math is unit-tested without any LLM call.
 */

/** One architecture finding the corpus expects BanGD to raise. */
export interface ExpectedFinding {
  file: string;
  /** Accepted finding types; empty/undefined ⇒ any type on that file counts. */
  types?: string[];
}

/** One ordinary code-level problem the corpus expects. */
export interface ExpectedGeneral {
  file: string;
  /** Accepted categories; empty/undefined ⇒ any category on that file counts. */
  categories?: string[];
}

/** Minimal shape of a predicted finding the scorer needs (structural anchors). */
export interface PredictedFinding {
  file: string;
  type: string;
}
export interface PredictedGeneral {
  file: string;
  category: string;
}

export interface Metrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Greedy one-to-one matching: each expected item consumes at most one predicted
 * item that satisfies `isMatch`, and vice versa. Returns the confusion counts.
 */
function confusion<E, P>(expected: E[], predicted: P[], isMatch: (e: E, p: P) => boolean): {
  tp: number;
  fp: number;
  fn: number;
} {
  const usedPred = new Set<number>();
  let tp = 0;
  for (const e of expected) {
    const hit = predicted.findIndex((p, i) => !usedPred.has(i) && isMatch(e, p));
    if (hit >= 0) {
      usedPred.add(hit);
      tp++;
    }
  }
  const fn = expected.length - tp;
  const fp = predicted.length - usedPred.size;
  return { tp, fp, fn };
}

/**
 * Precision / recall / F1 from confusion counts. Conventions for empty
 * denominators: with no predictions there are no false positives ⇒ precision 1;
 * with no expectations there is nothing to miss ⇒ recall 1; F1 is 0 only when
 * both precision and recall are 0.
 */
export function metricsFrom(tp: number, fp: number, fn: number): Metrics {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

/** Last path segment, tolerating both `/` and `\` separators. */
export function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

/** Same file by basename — robust to the model emitting a path differently. */
const sameFile = (a: string, b: string): boolean => baseName(a) === baseName(b);

const matchFinding = (e: ExpectedFinding, p: PredictedFinding): boolean =>
  sameFile(e.file, p.file) && (!e.types || e.types.length === 0 || e.types.includes(p.type));

const matchGeneral = (e: ExpectedGeneral, p: PredictedGeneral): boolean =>
  sameFile(e.file, p.file) && (!e.categories || e.categories.length === 0 || e.categories.includes(p.category));

/** Score architecture findings for one case. */
export function scoreFindings(expected: ExpectedFinding[], predicted: PredictedFinding[]): Metrics {
  const { tp, fp, fn } = confusion(expected, predicted, matchFinding);
  return metricsFrom(tp, fp, fn);
}

/** Score ordinary code-level findings for one case. */
export function scoreGeneral(expected: ExpectedGeneral[], predicted: PredictedGeneral[]): Metrics {
  const { tp, fp, fn } = confusion(expected, predicted, matchGeneral);
  return metricsFrom(tp, fp, fn);
}

/** Sum confusion counts across cases, then recompute metrics (micro-average). */
export function aggregate(metrics: Metrics[]): Metrics {
  const tp = metrics.reduce((s, m) => s + m.tp, 0);
  const fp = metrics.reduce((s, m) => s + m.fp, 0);
  const fn = metrics.reduce((s, m) => s + m.fn, 0);
  return metricsFrom(tp, fp, fn);
}

/** Round a 0..1 metric to a percentage with one decimal, e.g. 0.8333 → "83.3%". */
export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
