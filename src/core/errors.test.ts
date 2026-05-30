import { describe, it, expect } from 'vitest';
import { InvalidModelOutputError, rawSnippet } from './errors.js';

describe('InvalidModelOutputError', () => {
  it('carries the raw output', () => {
    const err = new InvalidModelOutputError({ foo: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err.raw).toEqual({ foo: 1 });
  });
});

describe('rawSnippet', () => {
  it('stringifies objects and truncates beyond the limit', () => {
    const s = rawSnippet({ a: 'x'.repeat(50) }, 20);
    expect(s.length).toBeLessThanOrEqual(20 + '…(已截断)'.length);
    expect(s).toContain('已截断');
  });

  it('passes through short strings and handles undefined', () => {
    expect(rawSnippet('hi')).toBe('hi');
    expect(rawSnippet(undefined)).toBe('undefined');
  });
});
