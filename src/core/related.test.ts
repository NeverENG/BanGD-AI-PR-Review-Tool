import { describe, it, expect, vi } from 'vitest';
import type { LlmClient, LlmRequest } from './ports.js';
import {
  planRelatedFiles,
  gatherRelatedFiles,
  RELATED_PLAN_SCHEMA,
  MAX_RELATED_FILES,
} from './related.js';

function plannerLlm(paths: unknown, capture?: (r: LlmRequest) => void): LlmClient {
  return {
    generateStructured: (request: LlmRequest) => {
      capture?.(request);
      return Promise.resolve({ paths });
    },
  };
}

const input = {
  diff: '+++ b/cache/block.go\n+c.hits++',
  changedFiles: ['cache/block.go'],
  loaded: [{ path: 'cache/block.go', content: 'package cache\nimport "db/storage"' }],
};

describe('planRelatedFiles', () => {
  it('returns the planner-named paths, trimmed and de-duplicated', async () => {
    const llm = plannerLlm(['storage/page.go', '  storage/page.go  ', 'a/storage/wal.go']);
    const paths = await planRelatedFiles(llm, input);
    // duplicate collapsed; the `a/` prefix stripped.
    expect(paths).toEqual(['storage/page.go', 'storage/wal.go']);
  });

  it('excludes files already in the changed set', async () => {
    const llm = plannerLlm(['cache/block.go', 'storage/page.go']);
    const paths = await planRelatedFiles(llm, input);
    expect(paths).toEqual(['storage/page.go']);
  });

  it('drops non-string and empty entries', async () => {
    const llm = plannerLlm(['storage/page.go', 42, '', null]);
    const paths = await planRelatedFiles(llm, input);
    expect(paths).toEqual(['storage/page.go']);
  });

  it(`caps the result at ${MAX_RELATED_FILES}`, async () => {
    const many = Array.from({ length: MAX_RELATED_FILES + 5 }, (_, i) => `pkg/file${i}.go`);
    const paths = await planRelatedFiles(plannerLlm(many), input);
    expect(paths).toHaveLength(MAX_RELATED_FILES);
  });

  it('returns [] when the planner output has no paths array', async () => {
    expect(await planRelatedFiles(plannerLlm(undefined), input)).toEqual([]);
    expect(await planRelatedFiles(plannerLlm('nope'), input)).toEqual([]);
  });

  it('never throws — returns [] when the planner call fails', async () => {
    const llm: LlmClient = { generateStructured: () => Promise.reject(new Error('boom')) };
    expect(await planRelatedFiles(llm, input)).toEqual([]);
  });

  it('calls the planner with the related-files schema', async () => {
    let seen: LlmRequest | undefined;
    await planRelatedFiles(plannerLlm(['storage/page.go'], (r) => (seen = r)), input);
    expect(seen?.outputSchema).toBe(RELATED_PLAN_SCHEMA);
    expect(seen?.user).toContain('cache/block.go');
  });
});

describe('gatherRelatedFiles', () => {
  it('fetches each planned path and drops misses (null)', async () => {
    const llm = plannerLlm(['storage/page.go', 'storage/gone.go']);
    const readFile = vi.fn((path: string) =>
      Promise.resolve(path === 'storage/page.go' ? 'package storage\ntype Page struct{}' : null),
    );
    const loaded = await gatherRelatedFiles(llm, readFile, input);
    expect(readFile).toHaveBeenCalledWith('storage/page.go');
    expect(readFile).toHaveBeenCalledWith('storage/gone.go');
    expect(loaded).toEqual([{ path: 'storage/page.go', content: 'package storage\ntype Page struct{}' }]);
  });

  it('returns [] when the planner names nothing', async () => {
    const readFile = vi.fn(() => Promise.resolve('x'));
    const loaded = await gatherRelatedFiles(plannerLlm([]), readFile, input);
    expect(loaded).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });
});
