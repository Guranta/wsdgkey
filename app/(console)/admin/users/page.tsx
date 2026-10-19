import { AdminUsersView } from "@/components/admin-users-view";
import { currentUser } from "@/lib/current-user";
import { getTranslations } from "next-intl/server";

export default async function AdminUsersPage() {
  const user = await currentUser();
  if (!user || user.role !== "admin") {
    const t = await getTranslations("errors");
    return <h1 className="text-[26px] font-bold leading-[1.25]">{t("pageForbidden")}</h1>;
  }
  return <AdminUsersView />;
}
