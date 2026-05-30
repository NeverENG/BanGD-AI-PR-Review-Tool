import { DIMENSIONS, type DimensionId } from './dimensions.js';

/** Cap on how many dimensions to send, to keep the prompt bounded. */
export const MAX_DIMENSIONS = 5;

/**
 * Heuristic router: pick the dimensions whose keywords appear in the review
 * material (diff text + changed-file paths). Order-preserving (registry order),
 * de-duplicated, capped at MAX_DIMENSIONS. Returns [] when nothing matches —
 * the caller then falls back to the LLM router.
 */
export function selectDimensionsHeuristic(material: string): DimensionId[] {
  const haystack = material.toLowerCase();
  const matched: DimensionId[] = [];
  for (const dim of DIMENSIONS) {
    if (dim.keywords.some((kw) => haystack.includes(kw))) {
      matched.push(dim.id);
    }
  }
  return matched.slice(0, MAX_DIMENSIONS);
}

/** Keep only valid dimension ids (e.g. from an LLM response), de-duped & capped. */
export function sanitizeDimensions(ids: string[]): DimensionId[] {
  const valid = new Set<string>(DIMENSIONS.map((d) => d.id));
  const out: DimensionId[] = [];
  for (const id of ids) {
    if (valid.has(id) && !out.includes(id as DimensionId)) out.push(id as DimensionId);
  }
  return out.slice(0, MAX_DIMENSIONS);
}
