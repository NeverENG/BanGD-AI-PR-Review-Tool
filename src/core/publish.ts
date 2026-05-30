import type { Finding } from './schema.js';

/**
 * Deterministic dedup identity for a finding. It must be byte-identical across
 * runs so re-reviews (on each push) don't file duplicate issues — so it's
 * computed in code from stable fields, NOT taken from the model (whose phrasing
 * drifts). `file:type` is the only stable identity available: line numbers move
 * and rootCause text varies. Consequence: two findings of the same type in the
 * same file collapse to one key → one issue (errs toward anti-spam by design).
 */
export function findingKey(finding: Finding): string {
  return `${finding.file.trim().toLowerCase()}:${finding.type}`;
}

/** Per-PR scoped key, so the same problem in different PRs gets distinct issues. */
export function fullKey(prNumber: number, finding: Finding): string {
  return `pr${prNumber}:${findingKey(finding)}`;
}

export interface ProblemGroup {
  /** `pr<N>:<file>:<type>` */
  fullKey: string;
  findings: Finding[];
}

/** Group findings by their per-PR key, preserving first-seen order. */
export function groupFindings(findings: Finding[], prNumber: number): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();
  const order: string[] = [];
  for (const finding of findings) {
    const key = fullKey(prNumber, finding);
    const existing = groups.get(key);
    if (existing) {
      existing.findings.push(finding);
    } else {
      groups.set(key, { fullKey: key, findings: [finding] });
      order.push(key);
    }
  }
  return order.map((key) => groups.get(key)).filter((g): g is ProblemGroup => g !== undefined);
}

/** Split groups into those not yet filed (fresh) and those already filed (known). */
export function partitionGroups(
  groups: ProblemGroup[],
  existingKeys: Set<string>,
): { fresh: ProblemGroup[]; known: ProblemGroup[] } {
  const fresh: ProblemGroup[] = [];
  const known: ProblemGroup[] = [];
  for (const group of groups) {
    if (existingKeys.has(group.fullKey)) known.push(group);
    else fresh.push(group);
  }
  return { fresh, known };
}
