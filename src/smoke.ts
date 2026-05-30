/**
 * Manual end-to-end smoke test: runs the real review pipeline (assemble prompts
 * → call the LLM → Zod-validate) against a sample diff, with no GitHub involved.
 * Used to verify the live LLM path "打通链路".
 *
 * Run:
 *   npm run build
 *   # Anthropic:
 *   ANTHROPIC_API_KEY=sk-... node build/smoke.js
 *   # DeepSeek (Anthropic-compatible endpoint):
 *   ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
 *   ANTHROPIC_API_KEY=<deepseek-key> BANGD_MODEL=deepseek-chat node build/smoke.js
 */
import { review } from './core/review.js';
import type { PrContext } from './core/ports.js';
import { groupFindings } from './core/publish.js';
import { AnthropicLlmClient } from './shell/llm.js';
import { loadPromptTexts } from './shell/prompts.js';
import { formatSummaryComment, formatIssueBody } from './shell/format.js';

const apiKey = process.env['ANTHROPIC_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'];
if (!apiKey) {
  console.error('请设置 ANTHROPIC_API_KEY（或 DEEPSEEK_API_KEY）。');
  process.exit(1);
}
const baseURL = process.env['ANTHROPIC_BASE_URL'];
const model = process.env['BANGD_MODEL'];

const SAMPLE_DIFF = `diff --git a/cache/block.go b/cache/block.go
--- a/cache/block.go
+++ b/cache/block.go
@@ -3,6 +3,7 @@ package cache
 type BlockCache struct {
 	blocks map[uint64]*Block
+	hits   uint64
 }

@@ -10,6 +11,9 @@ func (c *BlockCache) Get(id uint64) *Block {
 	b := c.blocks[id]
+	if b != nil {
+		c.hits++
+	}
 	return b
 }`;

// Full contents of the changed file, so the smoke run exercises A1's
// changed-file reading (not just the diff hunks).
const SAMPLE_FILES: Record<string, string> = {
  'cache/block.go': `package cache

type Block struct{ data []byte }

type BlockCache struct {
	blocks map[uint64]*Block
	hits   uint64
}

func (c *BlockCache) Get(id uint64) *Block {
	b := c.blocks[id]
	if b != nil {
		c.hits++
	}
	return b
}
`,
};

const pr: PrContext = {
  metadata: {
    title: 'cache: track block-cache hit count',
    body: '在块缓存读路径上新增命中计数，用于观测命中率。',
    number: null,
  },
  getDiff: () => Promise.resolve(SAMPLE_DIFF),
  readFile: (path: string) => Promise.resolve(SAMPLE_FILES[path] ?? null),
};

const prompts = await loadPromptTexts();
const llm = new AnthropicLlmClient({
  apiKey,
  ...(baseURL ? { baseURL } : {}),
  ...(model ? { model } : {}),
});

console.error(`调用模型 ${model ?? 'claude-opus-4-8'}${baseURL ? ` @ ${baseURL}` : ''} ...`);
const { result, dimensions } = await review({ llm, pr }, prompts);

console.error(`选中的评审维度：[${dimensions.join(', ')}]`);

// Simulate publishing locally (no GitHub): one group per architecture problem.
const groups = groupFindings(result.findings, 0);
const items = groups.map((group) => ({ group, url: null }));

console.log('=== PR 汇总评论 ===\n');
console.log(formatSummaryComment(result, items));
for (const group of groups) {
  console.log('\n=== Issue ===\n');
  console.log(formatIssueBody(group, 0));
}
console.log('\n--- raw ReviewResult ---\n' + JSON.stringify(result, null, 2));
