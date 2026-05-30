/**
 * Run `fn`, retrying up to `attempts` total tries on any thrown error. Used to
 * wrap the LLM-generate-then-validate step: a one-off bad generation (malformed
 * JSON / missing tool_use → Zod throws) gets another try. Transient HTTP errors
 * are handled lower down by the SDK's own retry; this layer covers the
 * pipeline-level "the model produced something we can't use" case.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  if (attempts < 1) throw new Error('attempts 必须 >= 1');
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
