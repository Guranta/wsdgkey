import { getTranslations } from "next-intl/server";
import { UpstreamBusy } from "./rate-queue";

type Values = Record<string, string | number>;

function hasKey(t: Awaited<ReturnType<typeof getTranslations>>, key: string): boolean {
  return (t as unknown as { has: (key: string) => boolean }).has(key);
}

export async function translateMessage(raw: string, values?: Values): Promise<string> {
  const t = await getTranslations("errors");
  const format = t as unknown as (key: string, values?: Values) => string;
  if (hasKey(t, raw)) return format(raw, values);
  if (/^[a-z][A-Za-z0-9]*$/.test(raw)) return format("generic");
  return raw;
}

export async function apiError(key: string, status: number, values?: Values): Promise<Response> {
  return Response.json(
    { error: { message: await translateMessage(key, values) } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function fromError(error: unknown, fallback: string): Promise<Response> {
  if (error instanceof UpstreamBusy) {
    return Response.json(
      { pending: true, message: await translateMessage("upstreamBusy") },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  }
  const status =
    typeof error === "object" && error && "status" in error && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 400;
  const values =
    typeof error === "object" && error && "values" in error
      ? ((error as { values?: Values }).values ?? undefined)
      : undefined;
  const raw = error instanceof Error && error.message ? error.message : fallback;
  return apiError(raw, status, values);
}
