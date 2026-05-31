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
import { fileURLToPath } from 'node:url';
import { review } from '../core/review.js';
import type { PrContext } from '../core/ports.js';
import { AnthropicLlmClient } from '../shell/llm.js';
import { loadPromptTexts } from '../shell/prompts.js';
import { formatUsage, totalTokens } from '../core/usage.js';
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

const CONFIGS: Config[] = [
  { label: 'baseline（无对抗式复核）', verifyVotes: 0 },
  { label: '优化后（对抗式复核 3 票/条）', verifyVotes: 3 },
];

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

async function runConfig(
  config: Config,
  cases: EvalCase[],
  apiKey: string,
  baseURL: string | undefined,
  model: string | undefined,
): Promise<ConfigResult> {
  // Fresh client per config → clean per-config token totals.
  const llm = new AnthropicLlmClient({
    apiKey,
    ...(model ? { model } : {}),
    ...(baseURL ? { baseURL } : {}),
  });
  const prompts = await loadPromptTexts();
  const results: CaseResult[] = [];

  for (const c of cases) {
    const pr: PrContext = {
      metadata: { title: c.title, body: c.body, number: null },
      getDiff: () => Promise.resolve(c.diff),
      readFile: () => Promise.resolve(null), // diff-only context, uniform across configs
    };
    try {
      const { result } = await review({ llm, pr }, prompts, { verifyVotes: config.verifyVotes });
      const predFindings = result.findings.map((f) => ({ file: f.file, type: f.type }));
      const predGeneral = result.generalFindings.map((g) => ({ file: g.file, category: g.category }));
      const findingMetrics = scoreFindings(c.expected.findings, predFindings);
      const generalFp = scoreGeneral(c.expected.generalFindings, predGeneral).fp;
      results.push({ case: c, predFindings, predGeneral, findingMetrics, generalFp });
      console.log(
        `  [${config.label}] ${c.source}: 架构 finding ${predFindings.length} 条 / 普通 ${predGeneral.length} 条 ` +
          `(P=${pct(findingMetrics.precision)} R=${pct(findingMetrics.recall)})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const empty = scoreFindings(c.expected.findings, []);
      results.push({ case: c, predFindings: [], predGeneral: [], findingMetrics: empty, generalFp: 0, error: msg });
      console.log(`  [${config.label}] ${c.source}: ERROR ${msg}`);
    }
  }

  return {
    config,
    cases: results,
    findings: aggregate(results.map((r) => r.findingMetrics)),
    generalFp: results.reduce((s, r) => s + r.generalFp, 0),
    tokens: totalTokens(llm.usage),
    usageText: formatUsage(llm.usage),
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
    '- **单变量 A/B**：两次运行只差一个变量——**对抗式复核关 / 开（0 票 vs 3 票）**；' +
      '模型、提示词（含 few-shot）、上下文全部一致，每个配置用全新客户端以隔离 token 计数。',
  );
  L.push('- **上下文**：仅 diff（`readFile` 返回 null），两配置一致，保证 A/B 可比。');
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

  const results: ConfigResult[] = [];
  for (const config of CONFIGS) {
    console.log(`\n=== 运行配置：${config.label} ===`);
    results.push(await runConfig(config, corpus.cases, apiKey, baseURL, model));
  }

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

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
