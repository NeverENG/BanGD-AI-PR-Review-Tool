/**
 * Pure helpers for building the code context sent to the model. Reviewing only
 * the diff makes BanGD a generic linter; including the *full* contents of the
 * changed files lets it see the untouched parts of those files (other methods,
 * same-file type definitions) needed for architecture-level reasoning.
 *
 * Note: this reads the *changed* files in full. It does NOT fetch untouched
 * *related* files (a struct defined elsewhere, the caller holding a lock) — that
 * is the job of a future model-driven file-request loop.
 */

export interface LoadedFile {
  path: string;
  content: string;
}

/**
 * Extract the post-image paths from a unified diff (the `+++ b/<path>` lines),
 * skipping deletions (`+++ /dev/null`). On renames the `+++` line already
 * carries the new path. De-duplicated, order-preserving.
 */
export function extractChangedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    let path = line.slice(4).trim();
    if (path === '/dev/null') continue;
    path = path.replace(/^[ab]\//, '');
    // Drop a trailing tab-separated timestamp some diff formats append.
    const tab = path.indexOf('\t');
    if (tab !== -1) path = path.slice(0, tab);
    if (path && !files.includes(path)) files.push(path);
  }
  return files;
}

/** Truncate a string to `max` chars, appending a marker when cut. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + `\n... [内容因超长被截断，省略 ${text.length - max} 字符] ...`, truncated: true };
}

/**
 * Assemble the changed-file contents into one block, including files until the
 * char budget is exhausted (the diff is sent separately and always kept). A
 * file that would overflow the budget is skipped, not partially included.
 */
export function assembleFilesBlock(
  files: LoadedFile[],
  budgetChars: number,
): { text: string; included: number; skipped: number } {
  const parts: string[] = [];
  let used = 0;
  let included = 0;
  let skipped = 0;
  for (const file of files) {
    const block = `### ${file.path}\n\`\`\`go\n${file.content}\n\`\`\``;
    if (used + block.length > budgetChars) {
      skipped++;
      continue;
    }
    parts.push(block);
    used += block.length;
    included++;
  }
  return { text: parts.join('\n\n'), included, skipped };
}
