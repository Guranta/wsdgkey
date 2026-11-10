import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { refillSupplierSnapshots } from "@/lib/supplier-billing";

/** Admin-only refill of the current Shanghai day's supplier snapshots.
 * Inserts rows only where a channel has none (ON CONFLICT DO NOTHING).
 * Does not overwrite an existing snapshot and does not write any other day. */
export async function POST() {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  const result = await refillSupplierSnapshots();
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
