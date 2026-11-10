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

/** Disabled-gateway figure. No readings stay missing (never $0). A partial set keeps the sum and names n/total. */
export function disabledGatewayAmountText(
  summary: { channels: number; readings?: number; consumption: number | null; complete: boolean } | null | undefined,
  money: (value: number) => string,
  missing: string,
  incomplete: string | ((readings: number, channels: number) => string),
): string {
  return readingAmountText(summary, money, missing, incomplete);
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
