export interface SearchableCommand {
  id: string;
  label: string;
  keywords?: string | readonly string[];
  detail?: string;
  disabled?: boolean;
}

export interface CommandSearchOptions {
  /** Most relevant commands for the current viewer state, in display order. */
  contextIds?: readonly string[];
  /** Most recently run commands, newest first. */
  recentIds?: readonly string[];
  /** Optional result cap. Empty searches are always capped at six. */
  limit?: number;
}

const EMPTY_RESULT_LIMIT = 6;

export function searchCommandActions<T extends SearchableCommand>(
  actions: readonly T[],
  query: string,
  options: CommandSearchOptions = {},
): T[] {
  const enabled = actions.filter((action) => !action.disabled);
  const normalizedQuery = normalize(query);

  if (!normalizedQuery) {
    const limit = Math.min(resultLimit(options.limit), EMPTY_RESULT_LIMIT);
    return orderedSuggestions(enabled, options).slice(0, limit);
  }

  const terms = normalizedQuery.split(" ");
  const contextRanks = idRanks(options.contextIds);
  const recentRanks = idRanks(options.recentIds);
  const ranked = enabled.flatMap((action, index) => {
    const score = matchScore(action, normalizedQuery, terms);
    return score === null ? [] : [{
      action,
      score,
      index,
      contextRank: contextRanks.get(action.id),
      recentRank: recentRanks.get(action.id),
    }];
  });

  ranked.sort((left, right) => (
    right.score - left.score
    || optionalRank(left.contextRank) - optionalRank(right.contextRank)
    || optionalRank(left.recentRank) - optionalRank(right.recentRank)
    || left.index - right.index
  ));

  return ranked.slice(0, resultLimit(options.limit)).map(({ action }) => action);
}

function orderedSuggestions<T extends SearchableCommand>(
  actions: readonly T[],
  options: CommandSearchOptions,
): T[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const seen = new Set<string>();
  const result: T[] = [];

  for (const id of [...(options.contextIds ?? []), ...(options.recentIds ?? [])]) {
    const action = byId.get(id);
    if (!action || seen.has(id)) continue;
    seen.add(id);
    result.push(action);
  }

  for (const action of actions) {
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    result.push(action);
  }

  return result;
}

function matchScore(
  action: SearchableCommand,
  query: string,
  terms: readonly string[],
): number | null {
  const label = normalize(action.label);
  const keywords = normalize(
    typeof action.keywords === "string" ? action.keywords : action.keywords?.join(" ") ?? "",
  );
  const detail = normalize(action.detail ?? "");
  const labelWords = label.split(" ");
  const keywordWords = keywords.split(" ");
  const detailWords = detail.split(" ");
  let score = 0;

  for (const term of terms) {
    const termScore = bestTermScore(
      term,
      label,
      labelWords,
      keywords,
      keywordWords,
      detail,
      detailWords,
    );
    if (termScore === 0) return null;
    score += termScore;
  }

  if (label === query) score += 1_000;
  else if (label.startsWith(query)) score += 500;
  else if (label.includes(query)) score += 250;

  if (keywords === query) score += 220;
  else if (keywords.startsWith(query)) score += 160;
  else if (keywords.includes(query)) score += 100;

  if (detail === query) score += 60;
  else if (detail.includes(query)) score += 30;

  return score;
}

function bestTermScore(
  term: string,
  label: string,
  labelWords: readonly string[],
  keywords: string,
  keywordWords: readonly string[],
  detail: string,
  detailWords: readonly string[],
): number {
  if (label === term) return 140;
  if (label.startsWith(term)) return 130;
  if (labelWords.some((word) => word.startsWith(term))) return 120;
  if (label.includes(term)) return 100;
  if (keywordWords.some((word) => word.startsWith(term))) return 80;
  if (keywords.includes(term)) return 60;
  if (detailWords.some((word) => word.startsWith(term))) return 40;
  if (detail.includes(term)) return 20;
  return 0;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function idRanks(ids: readonly string[] | undefined): Map<string, number> {
  const ranks = new Map<string, number>();
  ids?.forEach((id, index) => {
    if (!ranks.has(id)) ranks.set(id, index);
  });
  return ranks;
}

function optionalRank(rank: number | undefined): number {
  return rank ?? Number.MAX_SAFE_INTEGER;
}

function resultLimit(limit: number | undefined): number {
  if (limit === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(limit)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(limit));
}
