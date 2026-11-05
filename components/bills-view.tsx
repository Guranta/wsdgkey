"use client";

import { billFindingText, billLabelText, type Bill, type BillRow } from "@/components/billing-view";
import { useConnections } from "@/components/providers";
import { Alert, buttonClass, Card, PageHeader, useIsClient } from "@/components/ui";
import { channelTypeOption } from "@/lib/channel-types";
import { formatUsd } from "@/lib/format";
import { formatShanghaiTime } from "@/lib/shanghai";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useEffect, useState } from "react";

/** 每日账单：可选日期（默认最新一期），管理员可按供应商筛选，明细按渠道类型分段。 */
export function BillsView() {
  const { user } = useConnections();
  const hydrated = useIsClient();
  const t = useTranslations("billing");
  const errors = useTranslations("errors");
  const locale = useLocale();
  const [bill, setBill] = useState<Bill | null>(null);
  const [day, setDay] = useState("");
  const [supplier, setSupplier] = useState("");
  const [unsynced, setUnsynced] = useState(false);
  const [error, setError] = useState("");
  const admin = user?.role === "admin";

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (unsynced) params.set("unsynced", "1");
    if (day) params.set("day", day);
    if (supplier) params.set("supplier", supplier);
    const qs = params.toString();
    const load = () => {
      void fetch(`/api/billing${qs ? `?${qs}` : ""}`, { cache: "no-store" }).then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setError(errors("billingLoadFailed"));
          return;
        }
        if (!cancelled) {
          setBill((await res.json()) as Bill);
          setError("");
        }
      });
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hydrated, unsynced, day, supplier, errors]);

  if (!hydrated || !bill) return <p className="text-sm text-muted">{t("loading")}</p>;
  const money = (value: number) => formatUsd(value, locale);
  const cell = (value: number | null) => (value === null ? "—" : money(value));
  const dayMissing = Boolean(bill.requestedDay) && !bill.billDay;
  const max = Math.max(1, ...bill.trend.map((item) => item.value));
  const typeGroups = new Map<string, BillRow[]>();
  for (const row of bill.rows) {
    const key = row.typeName || "—";
    typeGroups.set(key, [...(typeGroups.get(key) ?? []), row]);
  }
  const sum = (rows: BillRow[], key: "today" | "before" | "cumulative") => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  const allRows = [...typeGroups.values()].flat();

  return (
    <div>
      <PageHeader title={t("billsTitle")} description={t("billsScope")} />
      {error ? <div className="mb-4"><Alert tone="danger">{error}</Alert></div> : null}
      {dayMissing ? <div className="mb-4"><Alert tone="info">{t("noBillDay", { day: bill.requestedDay ?? "—" })}</Alert></div> : null}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <input
          type="date"
          className="h-9 rounded-control border-0 bg-input px-3 text-sm"
          value={day}
          aria-label={t("pickDay")}
          onChange={(event) => {
            setDay(event.target.value);
            setUnsynced(false);
          }}
        />
        {admin && bill.suppliers.length ? (
          <select
            className="h-9 max-w-56 rounded-control border-0 bg-input px-3 text-sm"
            value={supplier}
            aria-label={t("supplierFilter")}
            onChange={(event) => {
              setSupplier(event.target.value);
            }}
          >
            <option value="">{t("allSuppliers")}</option>
            {bill.suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        ) : null}
        <span className="text-secondary">{t("periodLine", { day: bill.billDay ?? "—" })}</span>
        {bill.publishedAt ? <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok">{t("publishedPill")}</span> : null}
        {bill.collecting ? (
          <span className="whitespace-nowrap rounded-full bg-warn-soft px-3 py-1 text-warn">
            {bill.progress.etaMinutes ? t("collectingEta", { ok: bill.progress.ok, total: bill.progress.total, minutes: bill.progress.etaMinutes }) : t("collecting", { ok: bill.progress.ok, total: bill.progress.total })}
          </span>
        ) : null}
        {bill.progress.failed > 0 ? (
          <button type="button" className={buttonClass("secondary", "h-8 text-sm")} onClick={() => setUnsynced(true)}>
            {t("retryFailed", { count: bill.progress.failed })}
          </button>
        ) : null}
        {unsynced ? <button type="button" className={buttonClass("ghost", "h-8 text-sm")} onClick={() => setUnsynced(false)}>{t("showAll")}</button> : null}
      </div>
      <Card className="mb-4 p-4">
        <h2 className="text-sm font-semibold">{t("trend")}</h2>
        <div className="mt-4 flex h-36 items-end gap-2 overflow-x-auto">
          {bill.trend.length === 0 ? <p className="text-sm text-muted">{t("noTrend")}</p> : bill.trend.map((item) => (
            <div key={`${item.day}-${item.label}`} className="flex min-w-8 flex-1 flex-col items-center gap-1">
              <div className="w-full rounded-full" style={{ height: `${Math.max(8, (item.value / max) * 100)}%`, background: item.span ? "#FF9500" : "#007AFF" }} />
              <span className="whitespace-nowrap text-[10px] text-muted">{item.span ? billLabelText(t, item) : item.day.slice(5)}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{t("details")}</h2>
          <span className="text-xs text-muted">{t("unsyncedLegend", { count: bill.unsyncedCount })}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-[13px] font-semibold text-secondary">
              <tr>
                <th className="whitespace-nowrap px-4 py-3">{t("columns.channel")}</th>
                <th className="whitespace-nowrap px-4 py-3">{t("columns.today")}</th>
                <th className="whitespace-nowrap px-4 py-3">{t("columns.before")}</th>
                <th className="whitespace-nowrap px-4 py-3">{t("columns.total")}</th>
              </tr>
            </thead>
            <tbody>
              {bill.rows.length === 0 ? <tr><td colSpan={4} className="px-4 py-10 text-center text-muted">{dayMissing ? t("noBillDay", { day: bill.requestedDay ?? "—" }) : t("empty")}</td></tr> : [...typeGroups.entries()].map(([typeName, rows]) => {
                const first = rows[0];
                const meta = first ? channelTypeOption(first.type) : null;
                return (
                  <Fragment key={typeName}>
                    <tr className="bg-input">
                      <td className="whitespace-nowrap px-4 py-2 text-[13px] font-semibold">
                        <span className="inline-flex items-center gap-2">
                          {meta ? <span className="h-4 w-4 shrink-0 rounded-[5px]" style={{ background: meta.color }} aria-hidden /> : null}
                          {typeName}
                          <span className="font-normal text-muted">{t("sectionCount", { count: rows.length })}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-[13px] font-semibold tabular-nums">{cell(sum(rows, "today"))}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-[13px] font-semibold tabular-nums">{cell(sum(rows, "before"))}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-[13px] font-semibold tabular-nums">{cell(sum(rows, "cumulative"))}</td>
                    </tr>
                    {rows.map((row) => (
                      <tr key={row.id} className={`border-t border-line ${row.gray ? "text-muted" : ""}`}>
                        <td className="px-4 py-3">
                          <div className="font-medium">{row.name}</div>
                          <div className="text-xs text-muted">
                            {[row.group || "—", admin && row.supplier !== "unknown" ? row.supplier : ""].filter(Boolean).join(" · ")}
                          </div>
                          <div className="text-[11px] text-muted">{[row.rebindFrom && row.rebindTo ? t("rebindMarker", { from: row.rebindFrom, to: row.rebindTo }) : "", row.oldSegmentStatus === "unsynced" ? t("unsynced") : "", billFindingText(t, row.finding), billLabelText(t, row), row.backfillAt ? t("backfill", { time: formatShanghaiTime(row.backfillAt, locale) }) : ""].filter(Boolean).join(" · ")}</div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums">{cell(row.today)}</td>
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums">{cell(row.before)}</td>
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums">{cell(row.cumulative)}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
              {bill.rows.length ? (
                <>
                  <tr className="border-t border-line text-muted">
                    <td className="px-4 py-3 text-xs" colSpan={3}>{t("testLine")}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums">{money(bill.totalTestQuota)}</td>
                  </tr>
                  <tr className="border-t border-line font-semibold">
                    <td className="px-4 py-3">{t("grandTotal")}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">{cell(sum(allRows, "today"))}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">{cell(sum(allRows, "before"))}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">{cell(sum(allRows, "cumulative"))}</td>
                  </tr>
                </>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
