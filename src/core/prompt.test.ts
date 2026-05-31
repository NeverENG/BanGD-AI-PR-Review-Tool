import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt, assembleUserPrompt } from './prompt.js';

describe('assembleSystemPrompt', () => {
  it('includes the persona, selected rubric fragments, and architecture examples', () => {
    const sys = assembleSystemPrompt('PERSONA', ['RUBRIC_A', 'RUBRIC_B'], ['EX_A'], 'GENERAL');
    expect(sys).toContain('PERSONA');
    expect(sys).toContain('RUBRIC_A');
    expect(sys).toContain('RUBRIC_B');
    expect(sys).toContain('EX_A');
    expect(sys).toContain('架构级 Few-shot 范例');
  });

  it('always appends the generalFindings exemplar', () => {
    const sys = assembleSystemPrompt('PERSONA', ['RUBRIC_A'], ['EX_A'], 'GENERAL_EXEMPLAR');
    expect(sys).toContain('普通问题 Few-shot 范例');
    expect(sys).toContain('GENERAL_EXEMPLAR');
  });

  it('includes the general exemplar even when no dimension rubric/examples are selected', () => {
    const sys = assembleSystemPrompt('PERSONA', [], [], 'GENERAL_EXEMPLAR');
    expect(sys).toContain('PERSONA');
    expect(sys).toContain('GENERAL_EXEMPLAR');
    // No dimension fragments selected → no architecture rubric/examples blocks.
    expect(sys).not.toContain('评审 Rubric');
    expect(sys).not.toContain('架构级 Few-shot');
  });

  it('omits the general block when no exemplar is provided (defaults to empty)', () => {
    const sys = assembleSystemPrompt('PERSONA', ['RUBRIC_A'], []);
    expect(sys).not.toContain('普通问题 Few-shot 范例');
  });
});

describe('assembleUserPrompt', () => {
  const metadata = { title: 'T', body: 'B', number: 1 };

  it('asks for all four output parts including generalFindings', () => {
    const user = assembleUserPrompt(metadata, 'DIFF', '');
    expect(user).toContain('changeSummary');
    expect(user).toContain('findings');
    expect(user).toContain('generalFindings');
    expect(user).toContain('DIFF');
  });

  it('includes the changed-file and related-code blocks only when provided', () => {
    const bare = assembleUserPrompt(metadata, 'DIFF', '');
    expect(bare).not.toContain('被改动文件的完整内容');
    expect(bare).not.toContain('周边相关代码');

    const full = assembleUserPrompt(metadata, 'DIFF', 'FILES', 'RELATED');
    expect(full).toContain('被改动文件的完整内容');
    expect(full).toContain('FILES');
    expect(full).toContain('周边相关代码');
    expect(full).toContain('RELATED');
  });
});
