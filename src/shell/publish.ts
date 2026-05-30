import type { ReviewResult } from '../core/schema.js';
import { groupFindings, partitionGroups } from '../core/publish.js';
import { formatIssueTitle, formatIssueBody, formatSummaryComment, type CommentItem } from './format.js';

export interface ExistingIssue {
  fullKey: string;
  url: string;
}
export interface CreatedIssue {
  number: number;
  url: string;
}

/**
 * Where a review is published. Implemented by GithubPublisher; faked in tests.
 * Kept separate from PrContext (which only reads) so the read and write halves
 * stay independent.
 */
export interface ReviewPublisher {
  /** Open BanGD-filed issues with a parseable dedup key. */
  listExistingIssues(): Promise<ExistingIssue[]>;
  createIssue(input: { title: string; body: string }): Promise<CreatedIssue>;
  /** Create-or-update the single per-PR summary comment. */
  upsertSummaryComment(body: string): Promise<void>;
}

export interface PublishOutcome {
  created: number;
  reused: number;
  /** True if any issue failed to create (its detail was inlined into the comment). */
  degraded: boolean;
}

/**
 * Publish a review: file one issue per *new* architecture problem (skipping
 * problems already filed for this PR), then upsert one consolidated PR comment
 * linking to them. Non-blocking — issue-create failures degrade to inlining the
 * finding into the comment rather than failing the run.
 */
export async function publishReview(
  publisher: ReviewPublisher,
  result: ReviewResult,
  prNumber: number,
): Promise<PublishOutcome> {
  const groups = groupFindings(result.findings, prNumber);
  const existing = await publisher.listExistingIssues();
  const existingUrls = new Map(existing.map((e) => [e.fullKey, e.url]));
  const { known } = partitionGroups(groups, new Set(existingUrls.keys()));
  const knownKeys = new Set(known.map((g) => g.fullKey));

  const items: CommentItem[] = [];
  let created = 0;
  let degraded = false;

  for (const group of groups) {
    if (knownKeys.has(group.fullKey)) {
      items.push({ group, url: existingUrls.get(group.fullKey) ?? null });
      continue;
    }
    try {
      const issue = await publisher.createIssue({
        title: formatIssueTitle(group),
        body: formatIssueBody(group, prNumber),
      });
      created++;
      items.push({ group, url: issue.url });
    } catch {
      degraded = true;
      items.push({ group, url: null });
    }
  }

  await publisher.upsertSummaryComment(formatSummaryComment(result, items));
  return { created, reused: known.length, degraded };
}
