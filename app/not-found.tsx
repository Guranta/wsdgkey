import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";

export default function NotFound() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-secondary">正在打开…</div>}>
      <NotFoundBody />
    </Suspense>
  );
}

async function NotFoundBody() {
  const t = await getTranslations("system");
  return (
    <div className="rounded-card border border-line bg-card px-6 py-16 text-center">
      <h1 className="text-base font-medium">{t("notFoundTitle")}</h1>
      <p className="mt-2 text-sm text-secondary">{t("notFoundBody")}</p>
      <Link href="/channels" className="mt-5 inline-flex h-10 items-center justify-center whitespace-nowrap rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground">
        {t("back")}
      </Link>
    </div>
  );
}
