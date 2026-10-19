import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";

const TEMPLATE = "\uFEFF账期,网关,分组,渠道ID,渠道,我方消耗,日志,备注\n";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError("loginRequired", 401);
  return new Response(TEMPLATE, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="recon-template.csv"',
      "cache-control": "no-store",
    },
  });
}
