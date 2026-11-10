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

/** Disabled-gateway figure. No readings stay missing (never $0). A partial set keeps the sum and is marked incomplete. */
export function disabledGatewayAmountText(
  summary: { channels: number; consumption: number | null; complete: boolean } | null | undefined,
  money: (value: number) => string,
  missing: string,
  incomplete: string,
): string {
  if (!summary?.channels || summary.consumption === null) return missing;
  if (!summary.complete) return `${money(summary.consumption)} · ${incomplete}`;
  return money(summary.consumption);
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
