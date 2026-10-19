import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { reconCsv } from "@/lib/recon-service";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  const month = new URL(req.url).searchParams.get("month") ?? "";
  const csv = await reconCsv(user, month);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="recon-${month || "latest"}.csv"`,
      "cache-control": "no-store",
    },
  });
}
