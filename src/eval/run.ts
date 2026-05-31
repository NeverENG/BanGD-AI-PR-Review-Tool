/**
 * Evaluation runner (DESIGN.md §六.2). Runs BanGD over the frozen real-PR corpus
 * under two configs that differ in EXACTLY ONE variable — adversarial
 * verification off vs on — so any delta is attributable. Writes a report to
 * docs/评测报告.md with precision/recall/F1 and token cost per config.
 *
 * Single-variable design (see review notes): baseline first, then the one lever.
 * Everything else (model, prompts incl. few-shot, context) is held constant, and
 * each config uses a FRESH client so token counts don't bleed across the A/B.
 *
 * Key resolution (never logged): ANTHROPIC_API_KEY / DEEPSEEK_API_KEY env, else
 * the gitignored eval/.apikey file. baseURL via ANTHROPIC_BASE_URL, model via
 * BANGD_MODEL (same knobs as smoke.ts).
 *
 * Run:  npm run eval
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { review } from '../core/review.js';
import { verifyFindings, verifyGeneralFindings } from '../core/verify.js';
import type { LlmClient, PrContext } from '../core/ports.js';
import type { PromptTexts } from '../core/prompt.js';
import { AnthropicLlmClient } from '../shell/llm.js';
import { loadPromptTexts } from '../shell/prompts.js';
import { formatUsage, totalTokens, type TokenUsage } from '../core/usage.js';
import { loadCorpus, type EvalCase } from './corpus.js';
import {
  scoreFindings,
  scoreGeneral,
  aggregate,
  pct,
  type Metrics,
  type PredictedFinding,
  type PredictedGeneral,
} from './score.js';

interface Config {
  label: string;
  verifyVotes: number;
}

/** Adversarial refuters per finding in the "optimized" config (DESIGN §六.3). */
const VERIFY_VOTES = 3;
const BASELINE_LABEL = 'baseline（无对抗式复核）';
const OPTIMIZED_LABEL = `优化后（对抗式复核 ${VERIFY_VOTES} 票/条）`;

/** An LLM client that also exposes accumulated token usage (the shell client). */
export type EvalLlm = LlmClient & { usage: TokenUsage };

function resolveKey(): string {
  const env = process.env['ANTHROPIC_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'];
  if (env) return env.trim();
  let dir = fileURLToPath(new URL('.', import.meta.url));
  const root = parse(dir).root;
  for (;;) {
    const f = join(dir, 'eval', '.apikey');
    if (existsSync(f)) return readFileSync(f, 'utf8').trim();
    if (dir === root) break;
    dir = dirname(dir);
  }
  console.error(
    '找不到 API key。请设置 ANTHROPIC_API_KEY（或 DEEPSEEK_API_KEY），或把 key 写入 gitignored 的 eval/.apikey 文件。',
  );
  process.exit(1);
}

interface CaseResult {
  case: EvalCase;
  predFindings: PredictedFinding[];
  predGeneral: PredictedGeneral[];
  findingMetrics: Metrics;
  generalFp: number;
  error?: string;
}

interface ConfigResult {
  config: Config;
  cases: CaseResult[];
  findings: Metrics;
  generalFp: number;
  tokens: number;
  usageText: string;
}

function scoreCase(
  c: EvalCase,
  predFindings: PredictedFinding[],
  predGeneral: PredictedGeneral[],
): CaseResult {
  const findingMetrics = scoreFindings(c.expected.findings, predFindings);
  const generalFp = scoreGeneral(c.expected.generalFindings, predGeneral).fp;
  return { case: c, predFindings, predGeneral, findingMetrics, generalFp };
}

/**
 * Clean A/B (the key fix vs the first eval). Generate findings ONCE per PR, then
 * score TWO configs off that single generation: baseline = the raw findings,
 * optimized = the SAME findings after adversarial verification. The only variable
 * between configs is verification, so the precision delta can no longer be
 * confounded by the model's generation randomness — which the old design (two
 * independent `review()` calls, one per config) could not separate.
 *
 * Generation and verification use separate clients so token cost splits cleanly:
 * baseline pays for generation, optimized pays for the SAME generation plus the
 * verification overhead. Injecting both clients (rather than constructing them)
 * keeps this unit testable with fakes.
 */
export async function runCleanAB(
  cases: EvalCase[],
  prompts: PromptTexts,
  genLlm: EvalLlm,
  verifyLlm: EvalLlm,
): Promise<{ baseline: ConfigResult; optimized: ConfigResult }> {
  const baselineCases: CaseResult[] = [];
  const optimizedCases: CaseResult[] = [];

  for (const c of cases) {
    const pr: PrContext = {
      metadata: { title: c.title, body: c.body, number: null },
      getDiff: () => Promise.resolve(c.diff),
      readFile: () => Promise.resolve(null), // diff-only context, shared by both configs
    };
    try {
      // Generate ONCE (verification off) — this single generation feeds both configs.
      const { result } = await review({ llm: genLlm, pr }, prompts, { verifyVotes: 0 });
      const base = scoreCase(
        c,
        result.findings.map((f) => ({ file: f.file, type: f.type })),
        result.generalFindings.map((g) => ({ file: g.file, category: g.category })),
      );
      baselineCases.push(base);

      // Verify the SAME findings — the single A/B variable.
      const ctx = { changeSummary: result.changeSummary, diff: c.diff };
      const [arch, general] = await Promise.all([
        verifyFindings(verifyLlm, result.findings, ctx, VERIFY_VOTES),
        verifyGeneralFindings(verifyLlm, result.generalFindings, ctx, VERIFY_VOTES),
      ]);
      const opt = scoreCase(
        c,
        arch.kept.map((f) => ({ file: f.file, type: f.type })),
        general.kept.map((g) => ({ file: g.file, category: g.category })),
      );
      optimizedCases.push(opt);

      console.log(
        `  ${c.source}: 生成架构 ${base.predFindings.length} / 普通 ${base.predGeneral.length} 条；` +
          `复核后架构 ${opt.predFindings.length} / 普通 ${opt.predGeneral.length} 条`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errResult: CaseResult = { ...scoreCase(c, [], []), error: msg };
      baselineCases.push(errResult);
      optimizedCases.push(errResult);
      console.log(`  ${c.source}: ERROR ${msg}`);
    }
  }

  const genTokens = totalTokens(genLlm.usage);
  const verifyTokens = totalTokens(verifyLlm.usage);

  return {
    baseline: {
      config: { label: BASELINE_LABEL, verifyVotes: 0 },
      cases: baselineCases,
      findings: aggregate(baselineCases.map((r) => r.findingMetrics)),
      generalFp: baselineCases.reduce((s, r) => s + r.generalFp, 0),
      tokens: genTokens,
      usageText: formatUsage(genLlm.usage),
    },
    optimized: {
      config: { label: OPTIMIZED_LABEL, verifyVotes: VERIFY_VOTES },
      cases: optimizedCases,
      findings: aggregate(optimizedCases.map((r) => r.findingMetrics)),
      generalFp: optimizedCases.reduce((s, r) => s + r.generalFp, 0),
      // Generation is shared with baseline; optimized additionally pays for verification.
      tokens: genTokens + verifyTokens,
      usageText: `生成 ${formatUsage(genLlm.usage)}；复核 ${formatUsage(verifyLlm.usage)}`,
    },
  };
}

function reportMarkdown(results: ConfigResult[], cases: EvalCase[], meta: { date: string; model: string; endpoint: string }): string {
  const L: string[] = [];
  L.push('# BanGD 评测报告：对抗式复核对准确率与成本的影响');
  L.push('');
  L.push(`> 生成时间：${meta.date}｜模型：\`${meta.model}\`｜端点：${meta.endpoint}`);
  L.push('');
  L.push('## 方法');
  L.push('');
  L.push(
    `- **语料**：${cases.length} 个**真实** BanDB PR（\`eval/cases.json\`，由 \`eval/build-corpus.mjs\` 从 GitHub 冻结）。` +
      '标签来源：作者明示意图或**维护者在后续修复 PR 中确认**的缺陷——例如 #58 的崩溃一致性与 Stat→Seek 竞态，' +
      '由维护者在修复 PR #63 中确认并修复。',
  );
  L.push(
    '- **防泄漏**：真实 PR 描述常直接点明缺陷（如 #43 自述「刻意用并发写法检验 BanGD」），' +
      '会把答案喂给模型。故语料中**丢弃真实描述、改用中性事实化的一句话**，只有 diff（代码）进入模型。',
  );
  L.push(
    '- **匹配规则**：预测 finding 与期望 finding 按「文件名 + 类型集合」做一对一贪心匹配（见 `src/eval/score.ts`），' +
      '只认结构锚点、不比对措辞，避免被表述方式钻空子。',
  );
  L.push(
    `- **干净 A/B（生成一次 → 复核关/开）**：每个 PR 只**生成一次** finding，再对**同一批** finding 分别评分——` +
      `baseline=不复核，优化=对同一批做 ${VERIFY_VOTES} 票对抗式复核。唯一变量就是复核本身，` +
      '彻底消除了「生成随机性」对精确率结论的混淆（旧设计两次独立生成 finding，无法区分精确率变化来自复核、还是来自这次生成本就多报/少报）。',
  );
  L.push(
    '- **token 拆分**：生成与复核用两个客户端，干净归因——baseline=生成开销，优化=生成开销 + 复核开销；' +
      '二者的**生成部分是同一次调用**，完全可比。上下文两配置一致：仅 diff（`readFile` 返回 null）。',
  );
  L.push('');
  L.push('## 语料');
  L.push('');
  L.push('| PR | 期望架构 finding | 标签依据 |');
  L.push('|---|---|---|');
  for (const c of cases) {
    const exp = c.expected.findings.length === 0 ? '0（应保持干净）' : `${c.expected.findings.length} 条`;
    L.push(`| ${c.source} | ${exp} | ${c.groundTruth} |`);
  }
  L.push('');
  L.push('## 结果');
  L.push('');
  L.push('| 配置 | 精确率 P | 召回率 R | F1 | 架构误报(FP) | 漏报(FN) | 普通问题误报 | 消耗 token |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const m = r.findings;
    L.push(
      `| ${r.config.label} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${m.fp} | ${m.fn} | ${r.generalFp} | ${r.tokens.toLocaleString()} |`,
    );
  }
  L.push('');

  // Factual auto-generated delta (baseline → optimized). Honest framing: report
  // P/R/F1 and FP-count separately, and judge overall by F1 — a drop in FP count
  // is NOT a precision win if true findings were killed alongside.
  if (results.length === 2) {
    const [b, o] = results;
    if (b && o) {
      const dTok = o.tokens - b.tokens;
      const dTokPct = b.tokens > 0 ? Math.round((dTok / b.tokens) * 100) : 0;
      const f1Up = o.findings.f1 > b.findings.f1;
      const recallKilled = o.findings.recall < b.findings.recall;
      L.push('## 关键数字（自动生成；解读见下方手写结论）');
      L.push('');
      L.push(`- **F1（综合判据）**：${pct(b.findings.f1)} → ${pct(o.findings.f1)}（整体${f1Up ? '变好' : '变差'}）。`);
      L.push(`- **精确率**：${pct(b.findings.precision)} → ${pct(o.findings.precision)}。`);
      L.push(
        `- **召回率**：${pct(b.findings.recall)} → ${pct(o.findings.recall)}` +
          `${recallKilled ? '⚠️ 下降——复核误杀了真 finding（复核只删不增）' : ''}。`,
      );
      L.push(
        `- **架构误报数**：${b.findings.fp} → ${o.findings.fp} 条。` +
          '（注意：误报数下降 ≠ 精确率提升——若真 finding 同时被杀，精确率仍会掉。）',
      );
      L.push(
        `- **成本**：token ${b.tokens.toLocaleString()} → ${o.tokens.toLocaleString()}` +
          `（${dTok >= 0 ? '+' : ''}${dTokPct}%）。对抗式复核是用 token 换准确率，不是省钱手段。`,
      );
      L.push('');
    }
  }

  L.push('## 逐案明细');
  L.push('');
  for (const r of results) {
    L.push(`### ${r.config.label}`);
    L.push('');
    L.push('| PR | 期望 | 预测架构 finding | 预测普通问题 | P / R |');
    L.push('|---|---|---|---|---|');
    for (const cr of r.cases) {
      const pred = cr.error
        ? `（错误：${cr.error}）`
        : cr.predFindings.map((f) => `${f.type}@${f.file}`).join('；') || '—';
      const gen = cr.predGeneral.map((g) => `${g.category}@${g.file}`).join('；') || '—';
      const exp = cr.case.expected.findings.map((f) => `${(f.types ?? []).join('/')}` ).join('；') || '0';
      L.push(`| ${cr.case.source} | ${exp} | ${pred} | ${gen} | ${pct(cr.findingMetrics.precision)} / ${pct(cr.findingMetrics.recall)} |`);
    }
    L.push('');
  }

  L.push('## 局限');
  L.push('');
  L.push(`- 语料仅 ${cases.length} 例（召回锚点 2 例 / 3 条 finding），数字方差大，结论是趋势性的而非统计显著。`);
  L.push('- 标签虽锚定真实 PR 与维护者确认，仍含评审判断；匹配按文件+类型，可能与人工判定有出入。');
  L.push('- 仅用 diff 上下文（未喂改动文件全文/周边代码），低估了 BanGD 在完整上下文下的能力。');
  L.push('- 评测模型/端点见报告头部；用便宜的兼容端点冒烟与用 Opus 生产，质量不可直接外推。');
  L.push('');
  return L.join('\n');
}

async function main(): Promise<void> {
  const apiKey = resolveKey();
  const baseURL = process.env['ANTHROPIC_BASE_URL'];
  const model = process.env['BANGD_MODEL'];
  const corpus = await loadCorpus();
  console.log(`语料：${corpus.cases.length} 个真实 PR（${corpus.repo}）`);

  // Two fresh clients: one for the single generation, one for verification — so
  // token cost splits cleanly between the configs (see runCleanAB).
  const mkClient = (): EvalLlm =>
    new AnthropicLlmClient({ apiKey, ...(model ? { model } : {}), ...(baseURL ? { baseURL } : {}) });
  const prompts = await loadPromptTexts();

  console.log('\n=== 生成一次 → 对同一批做 复核关/开（干净 A/B）===');
  const { baseline, optimized } = await runCleanAB(corpus.cases, prompts, mkClient(), mkClient());
  const results: ConfigResult[] = [baseline, optimized];

  const date = new Date().toISOString().slice(0, 10);
  const md = reportMarkdown(results, corpus.cases, {
    date,
    model: model ?? 'claude-opus-4-8',
    endpoint: baseURL ?? 'Anthropic',
  });

  // Resolve docs/ relative to repo root (ascend from this module).
  let dir = fileURLToPath(new URL('.', import.meta.url));
  const root = parse(dir).root;
  while (!existsSync(join(dir, 'package.json')) && dir !== root) dir = dirname(dir);
  const out = join(dir, 'docs', '评测报告.md');
  writeFileSync(out, md, 'utf8');
  console.log(`\n报告已写入 ${out}`);
}

// Run only when invoked as the entry (node build/eval/run.js), NOT when imported
// by a test — importing must not kick off a live eval / exit the process.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
