/**
 * Ports (injected dependencies) the core review logic depends on. The core
 * imports neither Octokit nor `@actions/*` — the GitHub Action and the future
 * Probot App are thin shells that supply concrete implementations of these
 * interfaces. This is what keeps the Action→App swap cheap and the core unit-
 * testable with fakes (no network). See CLAUDE.md.
 */

export interface PrMetadata {
  title: string;
  body: string;
  /** PR number, when known (null in a bare-diff/CLI context). */
  number: number | null;
}

/**
 * Read access to the PR under review and its surrounding code. Reviewing only
 * the diff makes BanGD a generic linter; `readFile` lets the core pull the
 * surrounding code (callers/callees, data-structure definitions) needed for
 * architecture-level reasoning.
 */
export interface PrContext {
  readonly metadata: PrMetadata;
  /** The unified diff of the PR. */
  getDiff(): Promise<string>;
  /** Read a file's full contents from the head revision, or null if absent. */
  readFile(path: string): Promise<string | null>;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** JSON Schema the model's structured output must conform to. */
  outputSchema: Record<string, unknown>;
}

/**
 * Calls the LLM and returns its structured output as an unvalidated object.
 * The core (not the client) owns validation: it parses the result through the
 * Zod schema, so the boundary stays typed without `any`.
 */
export interface LlmClient {
  generateStructured(request: LlmRequest): Promise<unknown>;
}
