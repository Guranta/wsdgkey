import type { SessionUser } from "./types";

export function isSubAccount(actor: Pick<SessionUser, "parentUserId">): boolean {
  return Boolean(actor.parentUserId);
}

/** Channel, bill, and gateway owner. A sub-account inherits the parent supplier. */
export function scopeOwnerId(actor: Pick<SessionUser, "id" | "parentUserId">): string {
  return actor.parentUserId || actor.id;
}

/**
 * Who a newly created channel belongs to.
 * A gateway that already has an owner keeps that owner (the parent supplier).
 * Otherwise the row is filed under the acting account's scope, which is the parent for a sub-account.
 */
export function channelCreatorId(actor: Pick<SessionUser, "id" | "parentUserId">, gatewayOwnerId?: string | null): string {
  return gatewayOwnerId || scopeOwnerId(actor);
}

/** Sub-accounts use the parent's gateways. They cannot create, edit, or disable them. */
export function assertCanManageGateways(actor: Pick<SessionUser, "parentUserId">): void {
  if (actor.parentUserId) throw Object.assign(new Error("forbidden"), { status: 403 });
}
