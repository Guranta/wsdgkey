/** Multi-ID search stays a single indexed IN list. Above this, the rest is ignored so the query cannot grow without bound. */
export const CHANNEL_ID_SEARCH_CAP = 2000;
const NAME_CAP = 30;

export type ChannelKeyword = {
  /** One free-text token: name contains it, or it equals the channel id. */
  text: string;
  ids: number[];
  names: string[];
  recognized: number;
  truncated: boolean;
};

export function parseChannelKeyword(raw: string): ChannelKeyword {
  const tokens = raw
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (tokens.length <= 1) {
    return { text: tokens[0] ?? "", ids: [], names: [], recognized: tokens.length, truncated: false };
  }
  const ids: number[] = [];
  const names: string[] = [];
  for (const token of tokens) {
    if (/^\d{1,15}$/.test(token)) ids.push(Number(token));
    else names.push(token.slice(0, 80));
  }
  const uniqueIds = [...new Set(ids)];
  const uniqueNames = [...new Set(names)];
  return {
    text: "",
    ids: uniqueIds.slice(0, CHANNEL_ID_SEARCH_CAP),
    names: uniqueNames.slice(0, NAME_CAP),
    recognized: uniqueIds.length + uniqueNames.length,
    truncated: uniqueIds.length > CHANNEL_ID_SEARCH_CAP || uniqueNames.length > NAME_CAP,
  };
}

const SORTS = {
  before: "b.baseline",
  today: "CASE WHEN b.baseline IS NULL THEN c.today_quota ELSE (c.used_quota - b.baseline) END",
  total: "c.used_quota",
  id: "c.upstream_id",
} as const;

export type ChannelSort = keyof typeof SORTS;

export function channelOrder(sort: string | null, dir: string | null): { sort: ChannelSort; dir: "asc" | "desc"; sql: string } {
  const key: ChannelSort = sort && sort in SORTS ? (sort as ChannelSort) : "id";
  const direction = dir === "asc" ? "ASC" : "DESC";
  const expr = SORTS[key];
  return {
    sort: key,
    dir: direction === "ASC" ? "asc" : "desc",
    sql: `ORDER BY CASE WHEN ${expr} IS NULL THEN 1 ELSE 0 END, ${expr} ${direction}, c.upstream_id DESC`,
  };
}
