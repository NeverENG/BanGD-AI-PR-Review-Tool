import { describe, it, expect, vi } from 'vitest';
import { withRetry } from './retry.js';

describe('withRetry', () => {
  it('returns the result on first success without extra calls', async () => {
    const fn = vi.fn(() => Promise.resolve('ok'));
    await expect(withRetry(fn, 3)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries after a failure and succeeds within the attempt budget', async () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('bad gen')) : Promise.resolve('ok');
    });
    await expect(withRetry(fn, 2)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error when all attempts fail', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('still bad')));
    await expect(withRetry(fn, 2)).rejects.toThrow('still bad');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid attempt count', async () => {
    await expect(withRetry(() => Promise.resolve(1), 0)).rejects.toThrow();
  });
});
