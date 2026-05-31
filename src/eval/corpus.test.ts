import { describe, it, expect } from 'vitest';
import { loadCorpus } from './corpus.js';

/**
 * Invariants over the FROZEN corpus (eval/cases.json). These guard the corpus's
 * integrity contract — every case must be well-formed, and the leak guard
 * (neutral bodies) must hold — so a future `node eval/build-corpus.mjs` can't
 * silently regress provenance or shape. Labels themselves are documented in
 * build-corpus.mjs (groundTruth); here we only assert structure + a few anchors.
 */
describe('evaluation corpus (eval/cases.json)', () => {
  it('is well-formed: every case has provenance, a diff, and an expected shape', async () => {
    const { repo, cases } = await loadCorpus();
    expect(repo).toBe('NeverENG/BanDB');
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const c of cases) {
      expect(c.id, `id of ${c.source}`).toBeTruthy();
      expect(c.source).toContain(repo);
      expect(c.diff.length, `diff of ${c.source}`).toBeGreaterThan(0);
      expect(c.body.length, `body of ${c.source}`).toBeGreaterThan(0);
      expect(c.groundTruth.length, `groundTruth of ${c.source}`).toBeGreaterThan(0);
      expect(Array.isArray(c.expected.findings)).toBe(true);
      expect(Array.isArray(c.expected.generalFindings)).toBe(true);
    }
  });

  it('keeps neutral bodies leak-free (no defect-naming in the body fed to the model)', async () => {
    const { cases } = await loadCorpus();
    // The body must not hand the model the answer. The diff (real code) may
    // contain these terms — it's the review target — but the body must not.
    const leak = /goroutine[- ]?safe|data race|数据竞争|无中生有|刻意.*检验|误报/i;
    for (const c of cases) {
      expect(leak.test(c.body), `body of ${c.source} leaks the label`).toBe(false);
    }
  });

  it('preserves the two recall anchors (#43, #58) with non-empty expected findings', async () => {
    const { cases } = await loadCorpus();
    const anchors = cases.filter((c) => /#43$|#58$/.test(c.source));
    expect(anchors).toHaveLength(2);
    for (const a of anchors) expect(a.expected.findings.length).toBeGreaterThan(0);
  });

  it('adds the maintainer-adjudicated precision cases (#73, #72) as expect-0', async () => {
    const { cases } = await loadCorpus();
    for (const id of ['kway-merge-sstable', 'hermetic-test-cleanup']) {
      const c = cases.find((x) => x.id === id);
      expect(c, `case ${id} present`).toBeDefined();
      expect(c?.expected.findings).toHaveLength(0);
      expect(c?.expected.generalFindings).toHaveLength(0);
    }
  });
});
