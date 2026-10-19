const RANK: { pattern: RegExp; rank: number }[] = [
  { pattern: /nano|flash-lite|lite|mini|haiku|flash|small|8b|7b/i, rank: 1 },
  { pattern: /gpt-3\.5|sonnet|deepseek-chat/i, rank: 3 },
  { pattern: /gpt-4o(?!-mini)|pro|opus|o1|o3/i, rank: 8 },
];

/** Cheapest model on the channel. Lower rank wins; unknown names stay behind the named cheap tiers. */
export function cheapestModel(models: string): string {
  const list = models.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  if (!list.length) return "";
  let best = list[0]!;
  let bestRank = 50;
  for (const model of list) {
    let rank = 40;
    for (const item of RANK) {
      if (item.pattern.test(model)) rank = Math.min(rank, item.rank);
    }
    if (rank < bestRank) {
      best = model;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Channel tests in new-api v1.0.0-rc.45 send content "hi" and, for ordinary
 * chat models, max_tokens 16. The test API does not accept a custom prompt,
 * so the caller only chooses the model.
 */
export const MINIMAL_TEST_PROMPT = "hi";
export const MINIMAL_TEST_MAX_TOKENS = 16;
