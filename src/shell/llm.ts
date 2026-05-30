import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmRequest } from '../core/ports.js';

const SUBMIT_TOOL = 'submit_review';

export interface AnthropicLlmOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

/**
 * LlmClient backed by the Anthropic Messages API. Forces structured output via
 * a single tool (`submit_review`) whose input_schema is the caller-supplied
 * JSON Schema, and returns the tool input unvalidated (`unknown`) — the core
 * owns Zod validation. The fixed system block carries a `cache_control`
 * breakpoint so the per-PR diff (the user message) is the only uncached tail.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicLlmOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? 'claude-opus-4-8';
    this.maxTokens = options.maxTokens ?? 8192;
  }

  async generateStructured(request: LlmRequest): Promise<unknown> {
    const inputSchema: Anthropic.Tool.InputSchema = {
      ...request.outputSchema,
      type: 'object',
    };

    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
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

    const toolUse = message.content.find((block) => block.type === 'tool_use');
    if (!toolUse) {
      throw new Error('模型未返回 tool_use 结果，无法解析结构化评审。');
    }
    return toolUse.input;
  }
}
