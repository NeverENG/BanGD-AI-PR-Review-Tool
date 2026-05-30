import { describe, it, expect } from 'vitest';
import { findingKey, fullKey, groupFindings, partitionGroups } from './publish.js';
import type { Finding } from './schema.js';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'cache/block.go',
    line: 12,
    severity: '阻塞',
    type: '并发',
    rootCause: 'r',
    whyLowEffortInsufficient: 'w',
    architecturalSolution: 'a',
    tradeoffs: 't',
    ...over,
  };
}

describe('findingKey / fullKey', () => {
  it('is deterministic and independent of line/text', () => {
    const a = finding({ line: 12, rootCause: 'x' });
    const b = finding({ line: 99, rootCause: 'totally different wording' });
    expect(findingKey(a)).toBe(findingKey(b));
  });

  it('normalizes the file path', () => {
    expect(findingKey(finding({ file: '  Cache/Block.go ' }))).toBe('cache/block.go:并发');
  });

  it('scopes by PR number', () => {
    expect(fullKey(42, finding())).toBe('pr42:cache/block.go:并发');
  });
});

describe('groupFindings', () => {
  it('merges same file+type findings into one group', () => {
    const groups = groupFindings([finding(), finding({ line: 30 })], 42);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.findings).toHaveLength(2);
  });

  it('keeps distinct types/files as separate groups', () => {
    const groups = groupFindings(
      [finding(), finding({ type: '内存' }), finding({ file: 'wal.go' })],
      42,
    );
    expect(groups).toHaveLength(3);
  });
});

describe('partitionGroups', () => {
  it('splits known vs fresh by existing keys', () => {
    const groups = groupFindings([finding(), finding({ file: 'wal.go' })], 42);
    const { fresh, known } = partitionGroups(groups, new Set(['pr42:cache/block.go:并发']));
    expect(known).toHaveLength(1);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.fullKey).toBe('pr42:wal.go:并发');
  });
});
