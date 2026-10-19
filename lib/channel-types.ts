export { CHANNEL_TYPE_OPTIONS, NEW_API_RELEASE, channelTypeName, channelTypeOption } from "./channel-types.generated";
export type { ChannelTypeOption } from "./channel-types.generated";

/** Structural check for a channel base URL. A trailing /v1 is allowed and only warned in the form. */
export function validateChannelBaseUrl(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return { ok: true, value: "" };
  if (trimmed.length > 500) return { ok: false, error: "baseUrlTooLong" };
  if (/[\s\r\n]/.test(trimmed)) return { ok: false, error: "baseUrlSpaces" };
  let withProto = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(withProto)) withProto = `https://${withProto}`;
  let url: URL;
  try {
    url = new URL(withProto);
  } catch {
    return { ok: false, error: "baseUrlInvalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "baseUrlProtocol" };
  if (url.username || url.password || url.search || url.hash) return { ok: false, error: "baseUrlExtra" };
  return { ok: true, value: trimmed };
}
