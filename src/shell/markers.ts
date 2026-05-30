/**
 * Hidden HTML-comment markers BanGD embeds in the artifacts it creates, so it
 * can find and dedup them on later runs (issues by problem key, the one summary
 * comment by a fixed tag).
 */

/** Tag on the single per-PR summary comment, used to upsert (find→update). */
export const SUMMARY_MARKER = '<!-- bangd-summary -->';

/** Marker embedded in each issue body carrying its dedup key. */
export function issueKeyMarker(fullKey: string): string {
  return `<!-- bangd-key: ${fullKey} -->`;
}

const ISSUE_KEY_RE = /<!--\s*bangd-key:\s*(.+?)\s*-->/;

/** Parse the dedup key out of an issue body, or null if absent. */
export function parseIssueKey(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = ISSUE_KEY_RE.exec(body);
  return match ? (match[1] ?? null) : null;
}
