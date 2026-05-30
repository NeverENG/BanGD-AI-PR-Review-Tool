import * as core from '@actions/core';
import * as github from '@actions/github';
import { review } from '../core/review.js';
import { GithubPrContext, GithubPublisher } from './github.js';
import { AnthropicLlmClient } from './llm.js';
import { loadPromptTexts } from './prompts.js';
import { publishReview } from './publish.js';
import { formatDegradedComment } from './format.js';
import { formatUsage, totalTokens } from '../core/usage.js';
import { InvalidModelOutputError, rawSnippet } from '../core/errors.js';

function readString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

export async function run(): Promise<void> {
  const apiKey = core.getInput('anthropic_api_key', { required: true });
  const githubToken = core.getInput('github_token', { required: true });
  const model = core.getInput('model') || undefined;
  const baseUrl = core.getInput('base_url') || undefined;
  const verifyVotesRaw = parseInt(core.getInput('verify_votes'), 10);
  const verifyVotes = Number.isFinite(verifyVotesRaw) && verifyVotesRaw >= 0 ? verifyVotesRaw : 3;

  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.setFailed('BanGD 只能在 pull_request 事件上运行（找不到 PR 上下文）。');
    return;
  }

  const { owner, repo } = github.context.repo;
  const head = (pr['head'] ?? {}) as Record<string, unknown>;
  const octokit = github.getOctokit(githubToken);

  const prContext = new GithubPrContext(octokit, {
    owner,
    repo,
    pullNumber: pr.number,
    headRef: readString(head, 'sha'),
    metadata: {
      title: readString(pr, 'title'),
      body: readString(pr, 'body'),
      number: pr.number,
    },
  });

  const prompts = await loadPromptTexts();
  const llm = new AnthropicLlmClient({
    apiKey,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  });

  const publisher = new GithubPublisher(octokit, { owner, repo, pullNumber: pr.number });

  let reviewed: Awaited<ReturnType<typeof review>>;
  try {
    reviewed = await review({ llm, pr: prContext }, prompts, { verifyVotes });
  } catch (error) {
    if (error instanceof InvalidModelOutputError) {
      // Non-blocking: post a degraded comment + log the raw output for diagnosis
      // instead of failing the run.
      const snippet = rawSnippet(error.raw);
      core.warning(`模型未返回有效结构化评审，已降级。Token：${formatUsage(llm.usage)}。原始片段：${snippet}`);
      await publisher.upsertSummaryComment(formatDegradedComment(snippet));
      core.setOutput('finding_count', 0);
      core.setOutput('total_tokens', totalTokens(llm.usage));
      return;
    }
    throw error;
  }
  const { result, dimensions, relatedFiles, droppedFindings } = reviewed;

  const usage = llm.usage;
  const relatedNote = relatedFiles.length > 0 ? `｜补充阅读周边文件 [${relatedFiles.join(', ')}]` : '';
  const verifyNote =
    verifyVotes > 0
      ? `｜对抗式复核 ${verifyVotes} 票/条，过滤疑似误报 ${droppedFindings.length} 条`
      : '';
  const footer = `本次评审消耗 token：${formatUsage(usage)}｜维度 [${dimensions.join(', ')}]${relatedNote}${verifyNote}`;

  const published = await publishReview(publisher, result, pr.number, footer);

  core.setOutput('finding_count', result.findings.length);
  core.setOutput('total_tokens', totalTokens(usage));
  core.setOutput('dropped_count', droppedFindings.length);
  core.info(
    `BanGD 评审完成，维度=[${dimensions.join(', ')}]，共 ${result.findings.length} 条 finding` +
      `（对抗式复核过滤 ${droppedFindings.length} 条疑似误报）；` +
      `补充阅读周边文件 ${relatedFiles.length} 个${relatedFiles.length > 0 ? ` [${relatedFiles.join(', ')}]` : ''}；` +
      `新建 Issue ${published.created} 个，复用 ${published.reused} 个${published.degraded ? '（部分降级为内联）' : ''}。`,
  );
  core.info(`Token 用量：${formatUsage(usage)}`);
  await core.summary
    .addHeading('BanGD 评审', 3)
    .addRaw(`维度：${dimensions.join(', ')}；finding：${result.findings.length}；`)
    .addRaw(`新建 Issue ${published.created}，复用 ${published.reused}。`)
    .addRaw(`\n\nToken 用量：${formatUsage(usage)}`)
    .write();
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
