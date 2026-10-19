"use client";

import { KpiRing, QueueStrip, deltaText, type QueueSnap } from "@/components/channels-view";
import { useConnections } from "@/components/providers";
import { Alert, buttonClass, Card, PageHeader, useIsClient } from "@/components/ui";
import { formatUsd } from "@/lib/format";
import { formatShanghaiTime } from "@/lib/shanghai";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useEffect, useState } from "react";

type Slice = { name: string; value: number };
type BillRow = {
  id: string;
  name: string;
  group: string;
  supplier: string;
  consumption: number | null;
  today: number | null;
  before: number | null;
  cumulative: number | null;
  testQuota: number;
  kind: string;
  label: string;
  finding: string;
  span: string;
  spanDays: number;
  backfillAt: number | null;
  gray: boolean;
  rebindFrom?: number | null;
  rebindTo?: number | null;
  oldSegmentStatus?: string;
};
type Bill = {
  copy: string;
  collecting: boolean;
  progress: { total: number; ok: number; failed: number };
  publishedAt: number | null;
  publishedLabel: string;
  billDay: string | null;
  unsyncedCount: number;
  totalConsumption: number;
  totalTestQuota: number;
  remainingBalance: number;
  usedUsd: number;
  byType: Slice[];
  bySupplier: Slice[];
  byChannel: Slice[];
  byGroup: Slice[];
  trend: { day: string; label: string; spanDays: number; value: number; span: boolean }[];
  rows: BillRow[];
};

const COLORS = ["#34C759", "#FF2D55", "#A2845E", "#FF3B30", "#30B0C7", "#FF9500", "#007AFF", "#AF52DE", "#FFCC00", "#C7C7CC"];

function arcsFor(slices: Slice[], circumference: number) {
  const total = slices.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  return slices.reduce<{ name: string; value: number; sweep: number; offset: number; color: string }[]>((list, slice, index) => {
    const sweep = total > 0 ? (Math.max(0, slice.value) / total) * circumference : 0;
    const offset = list.reduce((sum, item) => sum + item.sweep, 0);
    list.push({ name: slice.name, value: slice.value, sweep, offset, color: COLORS[index % COLORS.length]! });
    return list;
  }, []);
}

function Donut({
  title,
  slices,
  size,
  stroke,
  center,
  caption,
  empty,
  unknown,
  money,
}: {
  title: string;
  slices: Slice[];
  size: number;
  stroke: number;
  center: string;
  caption: string;
  empty: string;
  unknown: string;
  money: (value: number) => string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const arcs = arcsFor(slices, c);
  const blank = arcs.length === 0 || arcs.every((arc) => arc.value <= 0);
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-3 flex items-center gap-4">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" role="img" aria-label={title}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#F0F0F0" strokeWidth={stroke} />
          {blank ? null : arcs.map((arc) => (
            <circle
              key={arc.name}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={arc.color}
              strokeWidth={stroke}
              strokeDasharray={`${arc.sweep} ${c}`}
              strokeDashoffset={-arc.offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          ))}
          <text x={size / 2} y={size / 2 - 4} textAnchor="middle" fontSize="14" fontWeight="700" fill="#0A0A0A">{blank ? empty : center}</text>
          {blank ? null : <text x={size / 2} y={size / 2 + 16} textAnchor="middle" fontSize="11" fill="#8A8A8A">{caption}</text>}
        </svg>
        <ul className="min-w-0 flex-1 space-y-1 text-xs">
          {blank ? <li className="text-muted">{empty}</li> : arcs.map((arc) => (
            <li key={arc.name} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5"><span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: arc.color }} /><span className="truncate">{arc.name === "unknown" ? unknown : arc.name}</span></span>
              <span className="shrink-0 whitespace-nowrap text-muted">{money(arc.value)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function BillingView() {
  const { user } = useConnections();
  const hydrated = useIsClient();
  const t = useTranslations("billing");
  const ct = useTranslations("channels");
  const errors = useTranslations("errors");
  const locale = useLocale();
  const [bill, setBill] = useState<Bill | null>(null);
  const [unsynced, setUnsynced] = useState(false);
  const [error, setError] = useState("");
  const admin = user?.role === "admin";

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const load = () => {
      void fetch(`/api/billing${unsynced ? "?unsynced=1" : ""}`, { cache: "no-store" }).then(async (res) => {
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
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hydrated, unsynced, errors]);

  const [overview, setOverview] = useState<{ total: number; running: number; anomaly: number; autoDisabled: number; pullFailed: number; todayQuota: number; yesterdayQuota: number; queue: QueueSnap } | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void fetch("/api/channels?page=1", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { stats?: { total: number; running: number; anomaly: number; autoDisabled: number; pullFailed: number; todayQuota: number; yesterdayQuota: number; queue: QueueSnap } };
        if (!cancelled && body.stats) setOverview(body.stats);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hydrated]);

  function labelText(row: { label: string; kind?: string; spanDays: number }): string {
    const raw = row.label;
    if (raw === "span2" || raw === "两日合计") return t("span2");
    if (raw === "spanN") return t("spanN", { count: row.spanDays });
    const counted = raw.match(/^(\d+)日合计$/);
    if (counted) return t("spanN", { count: Number(counted[1]) });
    if (raw === "unsynced" || raw === "未同步" || row.kind === "unsynced") return t("unsynced");
    if (raw === "noBaseline" || raw === "无基线" || row.kind === "no-baseline") return t("noBaseline");
    if (raw === "oneDay" || raw === "一日" || !raw) return t("oneDay");
    return raw;
  }

  function findingText(finding: string): string {
    if (finding === "missing" || finding === "网关上找不到") return t("missing");
    if (finding === "anomaly" || finding === "异常") return t("anomaly");
    return finding;
  }

  if (!hydrated || !bill) return <p className="text-sm text-muted">{t("loading")}</p>;
  const money = (value: number) => formatUsd(value, locale);
  const cell = (value: number | null) => (value === null ? "—" : money(value));
  const max = Math.max(1, ...bill.trend.map((item) => item.value));
  const groups = new Map<string, BillRow[]>();
  for (const row of bill.rows) {
    const key = row.group || "—";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const sum = (rows: BillRow[], key: "today" | "before" | "cumulative") => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  const allRows = [...groups.values()].flat();

  return (
    <div>
      <PageHeader title={t("title")} description={t("scope")} />
      {overview ? (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiRing label={ct("stats.total")} value={overview.total.toLocaleString(locale)} ratio={1} tone="#0A0A0A" hint="" />
            <KpiRing label={ct("stats.running")} value={overview.running.toLocaleString(locale)} ratio={overview.total ? overview.running / overview.total : 0} tone="#16A34A" hint={ct("stats.share", { percent: overview.total ? Math.round((overview.running / overview.total) * 1000) / 10 : 0 })} />
            <KpiRing label={ct("stats.anomaly")} value={overview.anomaly.toLocaleString(locale)} ratio={overview.total ? overview.anomaly / overview.total : 0} tone="#DC2626" hint={ct("stats.anomalyHint", { auto: overview.autoDisabled, pull: overview.pullFailed })} />
            <KpiRing label={ct("stats.today")} value={formatUsd(overview.todayQuota, locale)} ratio={overview.yesterdayQuota > 0 ? Math.min(1, overview.todayQuota / overview.yesterdayQuota) : 1} tone="#FF9500" hint={ct("stats.yesterday", { amount: formatUsd(overview.yesterdayQuota, locale), delta: deltaText(overview.todayQuota, overview.yesterdayQuota) })} />
          </div>
          {admin ? <div className="mb-3"><QueueStrip queue={overview.queue} admin={admin} /></div> : null}
        </>
      ) : null}
      {error ? <div className="mb-4"><Alert tone="danger">{error}</Alert></div> : null}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-secondary">{t("periodLine", { day: bill.billDay ?? "—" })}</span>
        {bill.publishedAt ? <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok">{t("publishedPill")}</span> : null}
        {bill.collecting ? <span className="whitespace-nowrap rounded-full bg-warn-soft px-3 py-1 text-warn">{t("collecting", { ok: bill.progress.ok, total: bill.progress.total })}</span> : null}
        {bill.progress.failed > 0 ? (
          <button type="button" className={buttonClass("secondary", "h-8 text-sm")} onClick={() => setUnsynced(true)}>
            {t("retryFailed", { count: bill.progress.failed })}
          </button>
        ) : null}
        {unsynced ? <button type="button" className={buttonClass("ghost", "h-8 text-sm")} onClick={() => setUnsynced(false)}>{t("showAll")}</button> : null}
      </div>
      <div className="mb-4 grid items-stretch gap-3 xl:grid-cols-[minmax(0,1.5fr)_16rem]">
        <Donut title={t("totalUse")} slices={bill.byType} size={240} stroke={28} center={money(bill.totalConsumption)} caption={t("usage")} empty={t("noData")} unknown={t("unknownSupplier")} money={money} />
        <Card className="px-4 py-4">
          <div className="text-xs text-secondary">{t("excluded")}</div>
          <div className="mt-1 text-2xl font-semibold">{bill.unsyncedCount}</div>
          <div className="mt-1 text-xs text-muted">{t("excludedHint")}</div>
        </Card>
      </div>
      <div className={`mb-4 grid gap-3 ${admin ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
        {admin ? <Donut title={t("bySupplier")} slices={bill.bySupplier} size={168} stroke={18} center={money(bill.totalConsumption)} caption={t("usage")} empty={t("noData")} unknown={t("unknownSupplier")} money={money} /> : null}
        <Donut title={t("byChannel")} slices={bill.byChannel} size={168} stroke={18} center={money(bill.totalConsumption)} caption={t("usage")} empty={t("noData")} unknown={t("unknownSupplier")} money={money} />
        <Donut title={t("byGroup")} slices={bill.byGroup} size={168} stroke={18} center={money(bill.totalConsumption)} caption={t("usage")} empty={t("noData")} unknown={t("unknownSupplier")} money={money} />
      </div>
      <Card className="mb-4 p-4">
        <h2 className="text-sm font-semibold">{t("trend")}</h2>
        <div className="mt-4 flex h-36 items-end gap-2 overflow-x-auto">
          {bill.trend.length === 0 ? <p className="text-sm text-muted">{t("noTrend")}</p> : bill.trend.map((item) => (
            <div key={`${item.day}-${item.label}`} className="flex min-w-8 flex-1 flex-col items-center gap-1">
              <div className="w-full rounded-full" style={{ height: `${Math.max(8, (item.value / max) * 100)}%`, background: item.span ? "#FF9500" : "#007AFF" }} />
              <span className="whitespace-nowrap text-[10px] text-muted">{item.span ? labelText(item) : item.day.slice(5)}</span>
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
                <th className="whitespace-nowrap px-4 py-3">{t("columns.channelGroup")}</th>
                <th className="whitespace-nowrap px-4 py-3">{t("columns.today")}</th>
                <th className="whitespace-nowrap px-4 py-3">{t("columns.before")}</th>
                <th className="whitespace-nowrap px-4 py-3">{t("columns.total")}</th>
              </tr>
            </thead>
            <tbody>
              {bill.rows.length === 0 ? <tr><td colSpan={4} className="px-4 py-10 text-center text-muted">{t("empty")}</td></tr> : [...groups.entries()].map(([group, rows]) => (
                <Fragment key={group}>
                  <tr className="bg-input">
                    <td className="whitespace-nowrap px-4 py-2 text-[13px] font-semibold">{group}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-[13px] font-semibold tabular-nums">{cell(sum(rows, "today"))}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-[13px] font-semibold tabular-nums">{cell(sum(rows, "before"))}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-[13px] font-semibold tabular-nums">{cell(sum(rows, "cumulative"))}</td>
                  </tr>
                  {rows.map((row) => (
                    <tr key={row.id} className={`border-t border-line ${row.gray ? "text-muted" : ""}`}>
                      <td className="px-4 py-3">
                        <div className="font-medium">{row.name}</div>
                        {admin ? <div className="text-xs text-muted">{row.supplier === "unknown" ? t("unknownSupplier") : row.supplier}</div> : null}
                        <div className="text-[11px] text-muted">{[row.rebindFrom && row.rebindTo ? t("rebindMarker", { from: row.rebindFrom, to: row.rebindTo }) : "", row.oldSegmentStatus === "unsynced" ? t("unsynced") : "", findingText(row.finding), labelText(row), row.backfillAt ? t("backfill", { time: formatShanghaiTime(row.backfillAt, locale) }) : ""].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums">{cell(row.today)}</td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums">{cell(row.before)}</td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums">{cell(row.cumulative)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
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
