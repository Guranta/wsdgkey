/** Shared end-of-list rule for gateway catalog sweeps.
 * A sweep may finish only when upstream published one finite total, every page
 * succeeded, and the unique ids collected equal that total. Anything else aborts
 * without marking channels missing and without writing a gateway-done snapshot. */

export const LIST_PAGE_SIZE = 20;

export type ListVerdict = "continue" | "complete" | "abort";

/** A total counts only when upstream sent a non-negative integer. Missing, blank, and non-numeric values are not totals. */
export function readExplicitTotal(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function judgeListPage(input: {
  explicitTotal: number | null;
  agreedTotal: number | null;
  itemCount: number;
  uniqueIds: number;
  errored?: boolean;
  pageSize?: number;
}): { verdict: ListVerdict; agreedTotal: number | null } {
  if (input.errored) return { verdict: "abort", agreedTotal: input.agreedTotal };
  if (input.explicitTotal === null) return { verdict: "abort", agreedTotal: input.agreedTotal };
  const agreed = input.agreedTotal === null ? input.explicitTotal : input.agreedTotal;
  if (input.explicitTotal !== agreed) return { verdict: "abort", agreedTotal: agreed };
  if (input.uniqueIds > agreed) return { verdict: "abort", agreedTotal: agreed };
  if (input.uniqueIds === agreed) return { verdict: "complete", agreedTotal: agreed };
  const pageSize = input.pageSize ?? LIST_PAGE_SIZE;
  if (input.itemCount === 0 || input.itemCount < pageSize) return { verdict: "abort", agreedTotal: agreed };
  return { verdict: "continue", agreedTotal: agreed };
}

/** One line per catalog page. Ids and counts only — never tokens, cookies, or passwords. */
export function logListPage(gatewayId: string, page: number, status: number, total: number | null, items: number): void {
  const totalText = total === null ? "missing" : String(total);
  console.info(`sync page gateway=${gatewayId} page=${page} status=${status} total=${totalText} items=${items}`);
}

export function httpStatusOf(error: unknown): number {
  if (typeof error === "object" && error && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isFinite(status)) return status;
  }
  return 0;
}

export type ListedPage<T> = { items: T[]; total: number | null };

/** Walk pages until the catalog is verified or the sweep must abort. `onItems` runs for every page that arrived. */
export async function walkListedPages<T extends { id: number }>(
  fetchPage: (page: number) => Promise<ListedPage<T>>,
  onItems: (items: T[]) => Promise<void>,
  maxPages = 2000,
): Promise<"complete" | "abort"> {
  let agreed: number | null = null;
  const seen = new Set<number>();
  for (let page = 1; page <= maxPages; page += 1) {
    let listed: ListedPage<T>;
    try {
      listed = await fetchPage(page);
    } catch {
      return "abort";
    }
    await onItems(listed.items);
    for (const item of listed.items) seen.add(item.id);
    const step = judgeListPage({
      explicitTotal: listed.total,
      agreedTotal: agreed,
      itemCount: listed.items.length,
      uniqueIds: seen.size,
    });
    agreed = step.agreedTotal;
    if (step.verdict === "complete") return "complete";
    if (step.verdict === "abort") return "abort";
  }
  return "abort";
}

export type SweepBook = {
  lastListSync: number;
  pages: Map<string, number>;
};

/** Start idle gateways on the interval. Leave an in-progress page number alone, and drop gateways that are no longer enabled. */
export function beginSweepTick(
  book: SweepBook,
  now: number,
  interval: number,
  gatewayIds: string[],
): { book: SweepBook; next: { id: string; page: number } | null } {
  const enabled = new Set(gatewayIds);
  const pages = new Map<string, number>();
  for (const [id, page] of book.pages) {
    if (enabled.has(id)) pages.set(id, page);
  }
  let lastListSync = book.lastListSync;
  if (now - lastListSync >= interval) {
    lastListSync = now;
    for (const id of gatewayIds) {
      if (!pages.has(id)) pages.set(id, 1);
    }
  }
  const first = pages.entries().next();
  if (first.done) return { book: { lastListSync, pages }, next: null };
  const [id, page] = first.value;
  return { book: { lastListSync, pages }, next: { id, page } };
}

/** One page was attempted. A finished or aborted sweep leaves the rotation; an open one goes to the back so other gateways get a turn. */
export function finishSweepTick(book: SweepBook, id: string, done: boolean): SweepBook {
  const pages = new Map(book.pages);
  const page = pages.get(id);
  if (page === undefined) return { lastListSync: book.lastListSync, pages };
  pages.delete(id);
  if (!done) pages.set(id, page + 1);
  return { lastListSync: book.lastListSync, pages };
}
