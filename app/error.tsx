"use client";

import { buttonClass } from "@/components/ui";
import { useTranslations } from "next-intl";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("system");
  const common = useTranslations("common");
  return (
    <div className="rounded-card border border-line bg-card px-6 py-16 text-center">
      <h1 className="text-base font-medium">{t("errorTitle")}</h1>
      <p className="mt-2 text-sm text-secondary">{t("errorBody")}</p>
      <button type="button" className={buttonClass("primary", "mt-5")} onClick={reset}>
        {common("retry")}
      </button>
    </div>
  );
}
