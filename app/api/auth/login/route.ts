import { loginFieldError } from "@/lib/account";
import { apiError, translateMessage } from "@/lib/api-error";
import { readJson } from "@/lib/http";
import { clientIp, clearUsernameFailures, loginRateLimited, loginUsernameKey, recordLoginFailure } from "@/lib/login-guard";
import { isLocale, localeCookieHeader } from "@/lib/locale";
import { getSession } from "@/lib/session";
import { createServerSession } from "@/lib/session-store";
import { publicUser, authenticate } from "@/lib/users";

async function tooMany(retryAfter: number): Promise<Response> {
  return Response.json(
    { error: { message: await translateMessage("loginRateLimited") } },
    { status: 429, headers: { "cache-control": "no-store", "retry-after": String(retryAfter) } },
  );
}

export async function POST(req: Request) {
  const body = (await readJson(req)) as { username?: unknown; password?: unknown } | null;
  const ip = clientIp(req.headers);
  const usernameKey = loginUsernameKey(body?.username);
  const blocked = loginRateLimited(ip, usernameKey);
  if (blocked.limited) return tooMany(blocked.retryAfter);

  const field = loginFieldError(body?.username, body?.password);
  if (field) return apiError(field, 400);

  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const result = await authenticate(username, password);
  if (result === "invalid" || result === "disabled") {
    const rate = recordLoginFailure(ip, usernameKey);
    if (rate.limited) return tooMany(rate.retryAfter);
    return apiError(result === "disabled" ? "accountDisabled" : "invalidCredentials", result === "disabled" ? 403 : 401);
  }
  clearUsernameFailures(usernameKey);
  const sessionId = await createServerSession(result.id);
  const session = await getSession();
  session.sessionId = sessionId;
  session.credentialVersion = result.credentialVersion;
  await session.save();
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (isLocale(result.locale)) headers["set-cookie"] = localeCookieHeader(result.locale);
  return Response.json(publicUser(result), { headers });
}
