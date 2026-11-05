/** Default name for a new supplier-account gateway. Users can edit it before save. */
export const DEFAULT_SELLER_GATEWAY_NAME = "ainow-seller";

/**
 * `ainow-4o14n1.example.com` → `ainow-seller`.
 * An empty or unparseable address stays on the default so the field is never blank.
 */
export function suggestSellerGatewayName(baseUrl: string): string {
  const raw = baseUrl.trim();
  if (!raw) return DEFAULT_SELLER_GATEWAY_NAME;
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const host = new URL(withProto).hostname.toLowerCase();
    const stem = (host.split(".")[0] ?? "").split("-")[0]?.replace(/[^a-z0-9]/g, "") ?? "";
    if (!stem) return DEFAULT_SELLER_GATEWAY_NAME;
    return `${stem}-seller`;
  } catch {
    return DEFAULT_SELLER_GATEWAY_NAME;
  }
}
