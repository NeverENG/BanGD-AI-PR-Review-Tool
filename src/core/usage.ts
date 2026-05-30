/**
 * Token accounting. The LLM client accumulates usage across all calls in a run
 * (routing + review), and the Action records the per-run total (log, step
 * summary, PR comment footer). Pure so it's testable without the network.
 */

export interface TokenUsage {
  /** Non-cached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache. */
  cacheCreationTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/** Grand total tokens billed for the run (all input flavors + output). */
export function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens + u.outputTokens;
}

/** Loosely-typed shape of an Anthropic `usage` block (fields may be absent/null). */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function extractUsage(raw: RawUsage | null | undefined): TokenUsage {
  if (!raw) return emptyUsage();
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadTokens: raw.cache_read_input_tokens ?? 0,
    cacheCreationTokens: raw.cache_creation_input_tokens ?? 0,
  };
}

/** One-line human summary, e.g. for logs and the PR comment footer. */
export function formatUsage(u: TokenUsage): string {
  return (
    `共 ${totalTokens(u)} tokens` +
    `（输入 ${u.inputTokens}，输出 ${u.outputTokens}，` +
    `缓存命中 ${u.cacheReadTokens}，缓存写入 ${u.cacheCreationTokens}）`
  );
}
