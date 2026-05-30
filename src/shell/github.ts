import type { getOctokit } from '@actions/github';
import type { PrContext, PrMetadata } from '../core/ports.js';

type Octokit = ReturnType<typeof getOctokit>;

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
