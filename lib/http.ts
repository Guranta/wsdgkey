export function jsonError(message: string, status: number): Response {
  return Response.json({ error: { message } }, { status, headers: { "cache-control": "no-store" } });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
