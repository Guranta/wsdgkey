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

/** Date input value. A hand-picked day wins. Otherwise show the bill actually loaded, never today's date. */
export function billingPickerDay(
  picked: string | null,
  bill: { billDay: string | null; requestedDay: string | null } | null,
): string {
  const explicit = picked?.trim() ?? "";
  if (explicit) return explicit;
  return bill?.billDay || bill?.requestedDay || "";
}
