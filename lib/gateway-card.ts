/** Card and settings-intro copy for a gateway.
 * Password-session kinds (supplier JWT, seller account) follow `authStatus`.
 * Admin gateways follow the access-token credential.
 */

export type GatewayCardInput = {
  kind?: string;
  authStatus?: string;
  disabled?: boolean;
  demo?: boolean;
  tokenSet?: boolean;
  tokenMasked?: string;
  username?: string;
};

export type GatewayCardCopy = {
  subtitle: "connected" | "needRelogin" | "account" | "token" | "demo" | "tokenMissing";
  pill: "deactivated" | "connected" | "needRelogin" | "connectionError" | "tokenInvalid";
  reloginTip: boolean;
  tone: "muted" | "ok" | "warn" | "danger";
};

export function passwordSessionKind(kind?: string): boolean {
  return kind === "newapi_supplier" || kind === "newapi_seller";
}

export function gatewayCardCopy(item: GatewayCardInput): GatewayCardCopy {
  if (item.kind === "newapi_supplier") {
    const ok = item.authStatus === "ok";
    if (item.disabled) return { subtitle: ok ? "connected" : "needRelogin", pill: "deactivated", reloginTip: false, tone: "muted" };
    if (ok) return { subtitle: "connected", pill: "connected", reloginTip: false, tone: "ok" };
    return { subtitle: "needRelogin", pill: "needRelogin", reloginTip: true, tone: "danger" };
  }
  if (item.kind === "newapi_seller") {
    const ok = item.authStatus === "ok";
    const failed = item.authStatus === "failed";
    if (item.disabled) return { subtitle: "account", pill: "deactivated", reloginTip: false, tone: "muted" };
    if (failed) return { subtitle: "account", pill: "connectionError", reloginTip: false, tone: "warn" };
    if (ok) return { subtitle: "account", pill: "connected", reloginTip: false, tone: "ok" };
    return { subtitle: "needRelogin", pill: "needRelogin", reloginTip: true, tone: "danger" };
  }
  const subtitle = item.tokenMasked ? "token" : item.demo ? "demo" : "tokenMissing";
  if (item.disabled) return { subtitle, pill: "deactivated", reloginTip: false, tone: "muted" };
  if (item.tokenSet || item.demo) return { subtitle, pill: "connected", reloginTip: false, tone: "ok" };
  return { subtitle, pill: "tokenInvalid", reloginTip: false, tone: "danger" };
}

export type SettingsIntroKey = "supplierHint" | "description" | "descriptionSession";

/** Page intro. Any password-session gateway replaces the admin access-token sentence. */
export function settingsIntroKey(input: { admin: boolean; kinds: Array<string | undefined>; draftingPassword?: boolean }): SettingsIntroKey {
  if (!input.admin) return "supplierHint";
  const password = Boolean(input.draftingPassword) || input.kinds.some((kind) => passwordSessionKind(kind));
  return password ? "descriptionSession" : "description";
}
