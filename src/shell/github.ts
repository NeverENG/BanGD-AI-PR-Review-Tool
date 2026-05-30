import type { getOctokit } from '@actions/github';
import type { PrContext, PrMetadata } from '../core/ports.js';
import type { ReviewPublisher, ExistingIssue, CreatedIssue } from './publish.js';
import { SUMMARY_MARKER, parseIssueKey } from './markers.js';

type Octokit = ReturnType<typeof getOctokit>;

const BANGD_LABEL = 'bangd';

export interface GithubPrParams {
  owner: string;
  repo: string;
  pullNumber: number;
  /** Head ref/sha used to read file contents at the PR's revision. */
  headRef: string;
  metadata: PrMetadata;
}

/** PrContext backed by the GitHub REST API via the Action's Octokit client. */
export class GithubPrContext implements PrContext {
  constructor(
    private readonly octokit: Octokit,
    private readonly params: GithubPrParams,
  ) {}

  get metadata(): PrMetadata {
    return this.params.metadata;
  }

  async getDiff(): Promise<string> {
    const res = await this.octokit.rest.pulls.get({
      owner: this.params.owner,
      repo: this.params.repo,
      pull_number: this.params.pullNumber,
      mediaType: { format: 'diff' },
    });
    // With `format: 'diff'` the response body is the raw diff text, though the
    // generated types still describe it as a PullRequest object.
    return res.data as unknown as string;
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const res = await this.octokit.rest.repos.getContent({
        owner: this.params.owner,
        repo: this.params.repo,
        path,
        ref: this.params.headRef,
      });
      const data = res.data;
      if (!Array.isArray(data) && data.type === 'file') {
        return Buffer.from(data.content, 'base64').toString('utf8');
      }
      return null;
    } catch {
      return null;
    }
  }
}

export interface GithubPublishParams {
  owner: string;
  repo: string;
  pullNumber: number;
}

/** ReviewPublisher backed by the GitHub REST API. */
export class GithubPublisher implements ReviewPublisher {
  constructor(
    private readonly octokit: Octokit,
    private readonly params: GithubPublishParams,
  ) {}

  async listExistingIssues(): Promise<ExistingIssue[]> {
    const res = await this.octokit.rest.issues.listForRepo({
      owner: this.params.owner,
      repo: this.params.repo,
      labels: BANGD_LABEL,
      state: 'open',
      per_page: 100,
    });
    const issues: ExistingIssue[] = [];
    for (const item of res.data) {
      // listForRepo also returns PRs (every PR is an issue in the API); skip them.
      if (item.pull_request) continue;
      const fullKey = parseIssueKey(item.body);
      if (fullKey) issues.push({ fullKey, url: item.html_url });
    }
    return issues;
  }

  async createIssue(input: { title: string; body: string }): Promise<CreatedIssue> {
    const res = await this.octokit.rest.issues.create({
      owner: this.params.owner,
      repo: this.params.repo,
      title: input.title,
      body: input.body,
      labels: [BANGD_LABEL],
    });
    return { number: res.data.number, url: res.data.html_url };
  }

  async upsertSummaryComment(body: string): Promise<void> {
    const existing = await this.octokit.rest.issues.listComments({
      owner: this.params.owner,
      repo: this.params.repo,
      issue_number: this.params.pullNumber,
      per_page: 100,
    });
    const mine = existing.data.find((c) => c.body?.includes(SUMMARY_MARKER));
    if (mine) {
      await this.octokit.rest.issues.updateComment({
        owner: this.params.owner,
        repo: this.params.repo,
        comment_id: mine.id,
        body,
      });
    } else {
      await this.octokit.rest.issues.createComment({
        owner: this.params.owner,
        repo: this.params.repo,
        issue_number: this.params.pullNumber,
        body,
      });
    }
  }
}
