import * as core from '@actions/core';
import * as github from '@actions/github';
import { review } from '../core/review.js';
import { GithubPrContext } from './github.js';
import { AnthropicLlmClient } from './llm.js';
import { loadPromptTexts } from './prompts.js';
import { formatReviewComment } from './format.js';

function readString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

export async function run(): Promise<void> {
  const apiKey = core.getInput('anthropic_api_key', { required: true });
  const githubToken = core.getInput('github_token', { required: true });
  const model = core.getInput('model') || undefined;

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
  const llm = new AnthropicLlmClient({ apiKey, ...(model ? { model } : {}) });

  const result = await review({ llm, pr: prContext }, prompts);

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: formatReviewComment(result),
  });

  core.setOutput('finding_count', result.findings.length);
  core.info(`BanGD 评审完成，共 ${result.findings.length} 条 finding。`);
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
