/** Query string for GET /api/billing. An empty day is omitted so the server picks the latest published bill. */
export function billingRequestQuery(input: { day?: string | null; unsynced?: boolean; supplier?: string | null }): string {
  const params = new URLSearchParams();
  const day = input.day?.trim() ?? "";
  if (day) params.set("day", day);
  if (input.unsynced) params.set("unsynced", "1");
  const supplier = input.supplier?.trim() ?? "";
  if (supplier) params.set("supplier", supplier);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** A real reading is kind=amount with a finite consumption, including 0. Missing and unsynced rows are not 0. */
export type ReadingSummary = {
  channels: number;
  readings: number;
  consumption: number | null;
  complete: boolean;
};

export function rollupReadingValues(rows: { kind?: string | null; consumption?: number | null }[]): ReadingSummary {
  let readings = 0;
  let sum = 0;
  for (const row of rows) {
    if (String(row.kind ?? "") !== "amount") continue;
    if (row.consumption === null || row.consumption === undefined) continue;
    const value = Number(row.consumption);
    if (!Number.isFinite(value)) continue;
    readings += 1;
    sum += value;
  }
  return {
    channels: rows.length,
    readings,
    consumption: readings > 0 ? sum : null,
    complete: rows.length > 0 && readings === rows.length,
  };
}

/**
 * No real readings → missing. Every channel has a reading → the amount.
 * A partial set keeps the sum and says how many channels were read, e.g. `$0.00 · 不完整（4/635 有读数）`.
 */
export function readingAmountText(
  summary: { channels: number; readings?: number; consumption: number | null; complete: boolean } | null | undefined,
  money: (value: number) => string,
  missing: string,
  incomplete: string | ((readings: number, channels: number) => string),
): string {
  if (!summary || summary.channels <= 0 || summary.consumption === null || summary.consumption === undefined) return missing;
  if (summary.complete) return money(summary.consumption);
  const note = typeof incomplete === "function" ? incomplete(summary.readings ?? 0, summary.channels) : incomplete;
  return `${money(summary.consumption)} · ${note}`;
}

/** Group subtotal and the grey disabled-gateway row share one readings format. */
export function groupSubtotalText(
  rows: { kind?: string | null; consumption?: number | null }[],
  money: (value: number) => string,
  missing: string,
  incomplete: (readings: number, channels: number) => string,
): string {
  return readingAmountText(rollupReadingValues(rows), money, missing, incomplete);
}

/**
 * Bills total-row label. New-rule days (unpublished, or aggregation dedup) stay 「合计」 / Total.
 * The amount cell already carries 「不完整（n/m 有读数）」. Legacy published days keep the old suffix.
 */
export function grandTotalLabel(
  aggregation: "legacy" | "dedup" | undefined,
  incomplete: boolean,
  total: string,
  incompleteMark: string,
): string {
  if (aggregation === "dedup") return total;
  return incomplete ? `${total} · ${incompleteMark}` : total;
}

/** Disabled-gateway figure. No readings stay missing (never $0). A partial set keeps the sum and names n/total. */
export function disabledGatewayAmountText(
  summary: { channels: number; readings?: number; consumption: number | null; complete: boolean } | null | undefined,
  money: (value: number) => string,
  missing: string,
  incomplete: string | ((readings: number, channels: number) => string),
): string {
  return readingAmountText(summary, money, missing, incomplete);
}

/**
 * The pre-#12 column total. No present values is 缺数据. A mix keeps the sum and the old
 * 「$0.00 · 不完整」 mark, without an n/total count.
 */
export function columnSummary(values: readonly (number | null | undefined)[]): { value: number | null; missing: boolean; partial: boolean } {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  const absent = values.some((value) => value === null || value === undefined);
  if (present.length === 0) return { value: null, missing: true, partial: false };
  return {
    value: present.reduce((total, value) => total + value, 0),
    missing: false,
    partial: absent,
  };
}

export function columnTotalText(
  summary: { value: number | null; missing: boolean; partial: boolean },
  money: (value: number) => string,
  missing: string,
  incomplete: string,
): string {
  if (summary.missing || summary.value === null) return missing;
  if (summary.partial) return `${money(summary.value)} · ${incomplete}`;
  return money(summary.value);
}

export type TrendAmountPoint = {
  day: string;
  label?: string;
  span?: boolean;
  legacy?: boolean;
  value: number | null;
  missing?: boolean;
  partial?: boolean;
  readings?: number;
  channels?: number;
  complete?: boolean;
};

/** Dedup days use the n/total reading text. Legacy days use the old column total. */
export function trendAmountText(
  item: TrendAmountPoint,
  money: (value: number) => string,
  missing: string,
  incomplete: string,
  readingsNote: (readings: number, channels: number) => string,
): string {
  if (item.legacy) {
    return columnTotalText(
      {
        value: item.missing || item.value === null || item.value === undefined ? null : item.value,
        missing: Boolean(item.missing) || item.value === null || item.value === undefined,
        partial: Boolean(item.partial),
      },
      money,
      missing,
      incomplete,
    );
  }
  return readingAmountText(
    {
      channels: item.channels ?? 0,
      readings: item.readings ?? 0,
      consumption: item.missing ? null : item.value,
      complete: Boolean(item.complete),
    },
    money,
    missing,
    readingsNote,
  );
}

/** Hover title: the visible date (or a multi-day range) plus the same text as that day's 合计 cell. */
export function trendHoverTitle(
  item: TrendAmountPoint,
  money: (value: number) => string,
  missing: string,
  incomplete: string,
  readingsNote: (readings: number, channels: number) => string,
): string {
  const prefix = item.span && item.label ? item.label : item.day.slice(5);
  return `${prefix} · ${trendAmountText(item, money, missing, incomplete, readingsNote)}`;
}

/** True when the chart window has days and every one of them is a real zero, not a missing or partial day. */
export function trendWindowAllZero(items: { value: number | null; missing?: boolean; partial?: boolean }[]): boolean {
  return items.length > 0 && items.every((item) => item.missing !== true && item.partial !== true && item.value === 0);
}

/** Date input value. A hand-picked day wins. Otherwise show the bill actually loaded, never today's date. */
export function billingPickerDay(
  picked: string | null,
  bill: { billDay: string | null; requestedDay: string | null } | null,
): string {
  const explicit = picked?.trim() ?? "";
  if (explicit) return explicit;
  return bill?.billDay || bill?.requestedDay || "";
}
