import { describe, it, expect } from 'vitest';
import { extractChangedFiles, truncate, assembleFilesBlock } from './context.js';

describe('extractChangedFiles', () => {
  it('extracts post-image paths and strips the b/ prefix', () => {
    const diff = [
      'diff --git a/cache/block.go b/cache/block.go',
      '--- a/cache/block.go',
      '+++ b/cache/block.go',
      '@@ -1 +1 @@',
    ].join('\n');
    expect(extractChangedFiles(diff)).toEqual(['cache/block.go']);
  });

  it('skips deletions (+++ /dev/null) and de-duplicates', () => {
    const diff = [
      '+++ b/a.go',
      '+++ /dev/null',
      '+++ b/a.go',
      '+++ b/storage/wal.go',
    ].join('\n');
    expect(extractChangedFiles(diff)).toEqual(['a.go', 'storage/wal.go']);
  });

  it('drops a trailing tab-separated timestamp', () => {
    expect(extractChangedFiles('+++ b/x.go\t2026-01-01 00:00:00')).toEqual(['x.go']);
  });

  it('returns empty for a diff with no +++ lines', () => {
    expect(extractChangedFiles('THE_DIFF')).toEqual([]);
  });
});

describe('truncate', () => {
  it('keeps text within the limit', () => {
    const r = truncate('abc', 10);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('abc');
  });
  it('cuts text over the limit and marks it', () => {
    const r = truncate('abcdefghij', 4);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('abcd')).toBe(true);
    expect(r.text).toContain('截断');
  });
});

describe('assembleFilesBlock', () => {
  it('includes files until the budget is exhausted, skipping the rest', () => {
    const files = [
      { path: 'a.go', content: 'x'.repeat(100) },
      { path: 'b.go', content: 'y'.repeat(100) },
      { path: 'c.go', content: 'z'.repeat(100) },
    ];
    const r = assembleFilesBlock(files, 160); // ~ room for one ~130-char block
    expect(r.included).toBe(1);
    expect(r.skipped).toBe(2);
    expect(r.text).toContain('a.go');
    expect(r.text).not.toContain('b.go');
  });

  it('includes everything when the budget is ample', () => {
    const files = [{ path: 'a.go', content: 'x' }];
    const r = assembleFilesBlock(files, 10_000);
    expect(r.included).toBe(1);
    expect(r.skipped).toBe(0);
  });
});
