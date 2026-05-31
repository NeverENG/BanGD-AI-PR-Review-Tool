import { describe, it, expect } from 'vitest';
import {
  metricsFrom,
  scoreFindings,
  scoreGeneral,
  aggregate,
  baseName,
  pct,
} from './score.js';

describe('metricsFrom', () => {
  it('computes precision/recall/F1 from confusion counts', () => {
    const m = metricsFrom(3, 1, 1); // tp=3 fp=1 fn=1
    expect(m.precision).toBeCloseTo(0.75);
    expect(m.recall).toBeCloseTo(0.75);
    expect(m.f1).toBeCloseTo(0.75);
  });

  it('treats no predictions as precision 1 (no false positives)', () => {
    expect(metricsFrom(0, 0, 2).precision).toBe(1);
    expect(metricsFrom(0, 0, 2).recall).toBe(0); // missed both
  });

  it('treats no expectations as recall 1 (nothing to miss)', () => {
    expect(metricsFrom(0, 0, 0).recall).toBe(1);
    expect(metricsFrom(0, 0, 0).precision).toBe(1);
    expect(metricsFrom(0, 0, 0).f1).toBe(1);
  });

  it('F1 is 0 when both precision and recall are 0', () => {
    expect(metricsFrom(0, 2, 2).f1).toBe(0);
  });
});

describe('baseName', () => {
  it('takes the last segment for / and \\ paths', () => {
    expect(baseName('storage/zstorage/SSTable.go')).toBe('SSTable.go');
    expect(baseName('storage\\zstorage\\SSTable.go')).toBe('SSTable.go');
    expect(baseName('flat.go')).toBe('flat.go');
  });
});

describe('scoreFindings', () => {
  it('matches by basename + accepted type, one-to-one', () => {
    const expected = [{ file: 'storage/zstorage/SSTable.go', types: ['存储', '并发'] }];
    // Predicted on the same file by basename, with an accepted type → TP.
    const m = scoreFindings(expected, [{ file: 'SSTable.go', type: '存储' }]);
    expect(m).toMatchObject({ tp: 1, fp: 0, fn: 0 });
  });

  it('counts a wrong-type prediction on the right file as FP + FN', () => {
    const expected = [{ file: 'a.go', types: ['并发'] }];
    const m = scoreFindings(expected, [{ file: 'a.go', type: '性能' }]);
    expect(m).toMatchObject({ tp: 0, fp: 1, fn: 1 });
  });

  it('empty types accepts any type on the file', () => {
    const m = scoreFindings([{ file: 'a.go' }], [{ file: 'a.go', type: '资源' }]);
    expect(m.tp).toBe(1);
  });

  it('extra predictions on a clean case are false positives', () => {
    const m = scoreFindings([], [{ file: 'a.go', type: '并发' }]);
    expect(m).toMatchObject({ tp: 0, fp: 1, fn: 0 });
    expect(m.precision).toBe(0);
  });

  it('does not double-count two predictions against one expected', () => {
    const expected = [{ file: 'a.go', types: ['并发'] }];
    const m = scoreFindings(expected, [
      { file: 'a.go', type: '并发' },
      { file: 'a.go', type: '并发' },
    ]);
    expect(m).toMatchObject({ tp: 1, fp: 1, fn: 0 });
  });
});

describe('scoreGeneral', () => {
  it('matches general findings by basename + category', () => {
    const m = scoreGeneral(
      [{ file: 'x.go', categories: ['逻辑错误'] }],
      [{ file: 'x.go', category: '逻辑错误' }],
    );
    expect(m.tp).toBe(1);
  });
});

describe('aggregate', () => {
  it('micro-averages by summing confusion counts then recomputing', () => {
    const a = metricsFrom(1, 0, 0); // P=1 R=1
    const b = metricsFrom(0, 1, 1); // P=0 R=0
    const agg = aggregate([a, b]); // tp1 fp1 fn1
    expect(agg).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    expect(agg.precision).toBeCloseTo(0.5);
    expect(agg.recall).toBeCloseTo(0.5);
  });
});

describe('pct', () => {
  it('formats a 0..1 ratio as a one-decimal percentage', () => {
    expect(pct(0.8333)).toBe('83.3%');
    expect(pct(1)).toBe('100.0%');
  });
});
