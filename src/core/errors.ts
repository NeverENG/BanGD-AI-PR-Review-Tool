/**
 * Raised when the model's output can't be validated into a ReviewResult even
 * after retries. Carries the raw output so the shell can log it (for diagnosis)
 * and degrade gracefully instead of crashing the run.
 */
export class InvalidModelOutputError extends Error {
  readonly raw: unknown;
  constructor(raw: unknown) {
    super('模型未返回可解析的结构化评审结果');
    this.name = 'InvalidModelOutputError';
    this.raw = raw;
  }
}

/** A bounded, log-safe string view of an arbitrary raw value. */
export function rawSnippet(raw: unknown, max = 800): string {
  let s: string;
  if (typeof raw === 'string') s = raw;
  else {
    try {
      s = JSON.stringify(raw) ?? String(raw);
    } catch {
      s = String(raw);
    }
  }
  return s.length > max ? `${s.slice(0, max)}…(已截断)` : s;
}
