import { apiError, fromError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";
import { createSupplier, listUsers } from "@/lib/users";

function listed(users: Awaited<ReturnType<typeof listUsers>>) {
  return users.map((item) => ({
    id: item.id,
    username: item.username,
    name: item.name,
    role: item.role,
    disabled: item.disabled,
    createdAt: item.createdAt,
    channelCount: item.channelCount ?? 0,
  }));
}

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  return Response.json(listed(await listUsers()), { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  if (user.role !== "admin") return apiError("forbidden", 403);
  const body = (await readJson(req)) as { username?: unknown; name?: unknown; password?: unknown } | null;
  try {
    const created = await createSupplier({
      username: String(body?.username ?? ""),
      name: typeof body?.name === "string" && body.name.trim() ? body.name : String(body?.username ?? ""),
      password: String(body?.password ?? ""),
    });
    return Response.json(
      { id: created.id, username: created.username, name: created.name, role: created.role },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status) return fromError(error, "userCreateFailed");
    throw error;
  }
}
