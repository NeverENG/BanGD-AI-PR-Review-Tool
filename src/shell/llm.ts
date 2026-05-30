import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmRequest } from '../core/ports.js';
import { addUsage, emptyUsage, extractUsage, type TokenUsage } from '../core/usage.js';

const SUBMIT_TOOL = 'submit_review';

export interface AnthropicLlmOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  /**
   * Override the API base URL to point at an Anthropic-compatible provider
   * (e.g. DeepSeek's `https://api.deepseek.com/anthropic`). Leave unset for
   * Anthropic itself.
   */
  baseURL?: string;
  /** Force prompt caching on/off; defaults to on only for Anthropic itself. */
  promptCaching?: boolean;
  /** SDK-level retries on transient HTTP errors (429/5xx). Default 2. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 120_000. */
  timeoutMs?: number;
}

/**
 * Prompt caching is an Anthropic-specific feature; compatible third-party
 * endpoints may reject the `cache_control` field. So cache only when talking to
 * Anthropic directly (no `baseURL`), unless explicitly overridden.
 */
export function shouldUsePromptCaching(baseURL?: string, override?: boolean): boolean {
  return override ?? baseURL === undefined;
}

/**
 * LlmClient backed by the Anthropic Messages API (or an Anthropic-compatible
 * provider via `baseURL`). Forces structured output via a single tool
 * (`submit_review`) whose input_schema is the caller-supplied JSON Schema, and
 * returns the tool input unvalidated (`unknown`) — the core owns Zod validation.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly caching: boolean;
  private accumulated: TokenUsage = emptyUsage();

  /** Cumulative token usage across every call made by this client. */
  get usage(): TokenUsage {
    return this.accumulated;
  }

  constructor(options: AnthropicLlmOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 120_000,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.model = options.model ?? 'claude-opus-4-8';
    this.maxTokens = options.maxTokens ?? 8192;
    this.caching = shouldUsePromptCaching(options.baseURL, options.promptCaching);
  }

  async generateStructured(request: LlmRequest): Promise<unknown> {
    const inputSchema: Anthropic.Tool.InputSchema = {
      ...request.outputSchema,
      type: 'object',
    };

    const system: Anthropic.MessageCreateParams['system'] = this.caching
      ? [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }]
      : request.system;

    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: [
        {
          name: SUBMIT_TOOL,
          description: '提交对该 PR 的结构化评审结果。',
          input_schema: inputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: SUBMIT_TOOL },
      messages: [{ role: 'user', content: request.user }],
    });

    this.accumulated = addUsage(this.accumulated, extractUsage(message.usage));

    const toolUse = message.content.find((block) => block.type === 'tool_use');
    if (!toolUse) {
      throw new Error('模型未返回 tool_use 结果，无法解析结构化评审。');
    }
    return toolUse.input;
  }
}
