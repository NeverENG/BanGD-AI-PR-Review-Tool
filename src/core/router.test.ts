import { describe, it, expect } from 'vitest';
import { selectDimensionsHeuristic, sanitizeDimensions, MAX_DIMENSIONS } from './router.js';

describe('selectDimensionsHeuristic', () => {
  it('selects concurrency on sync/goroutine signals', () => {
    const dims = selectDimensionsHeuristic('func (c *Cache) Get() { c.hits++ } // no sync.Mutex, goroutine');
    expect(dims).toContain('concurrency');
  });

  it('selects storage on WAL signals', () => {
    expect(selectDimensionsHeuristic('append to wal then fsync the checkpoint')).toContain('storage');
  });

  it('returns empty when nothing matches (caller falls back to LLM)', () => {
    expect(selectDimensionsHeuristic('just some prose with no signals')).toEqual([]);
  });

  it('caps the number of selected dimensions', () => {
    const everything = 'goroutine sync. unsafe lock( wal alter index defer panic proto';
    expect(selectDimensionsHeuristic(everything).length).toBeLessThanOrEqual(MAX_DIMENSIONS);
  });
});

describe('sanitizeDimensions', () => {
  it('keeps only valid ids, de-duped', () => {
    expect(sanitizeDimensions(['concurrency', 'bogus', 'concurrency', 'storage'])).toEqual([
      'concurrency',
      'storage',
    ]);
  });
});
