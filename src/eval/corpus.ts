/**
 * Loads the frozen evaluation corpus (eval/cases.json), built from real BanDB
 * PRs by eval/build-corpus.mjs. Kept separate from the scorer so the scoring
 * math stays a pure, dependency-free unit.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExpectedFinding, ExpectedGeneral } from './score.js';

export interface EvalCase {
  id: string;
  /** Provenance, e.g. "NeverENG/BanDB#43". */
  source: string;
  title: string;
  /** NEUTRALIZED body (never the real one — see build-corpus.mjs eval-leak guard). */
  body: string;
  diff: string;
  expected: { findings: ExpectedFinding[]; generalFindings: ExpectedGeneral[] };
  /** Why the label is trustworthy (author intent / maintainer-confirmed fix). */
  groundTruth: string;
}

export interface Corpus {
  repo: string;
  cases: EvalCase[];
}

/** Ascend from this module to find eval/cases.json (layout-independent). */
function findCasesFile(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  const root = parse(dir).root;
  for (;;) {
    const candidate = join(dir, 'eval', 'cases.json');
    if (existsSync(candidate)) return candidate;
    if (dir === root) throw new Error('找不到 eval/cases.json（请先运行 node eval/build-corpus.mjs）。');
    dir = dirname(dir);
  }
}

export async function loadCorpus(): Promise<Corpus> {
  const raw = await readFile(findCasesFile(), 'utf8');
  return JSON.parse(raw) as Corpus;
}
