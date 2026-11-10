"use client";

import { KpiRing, QueueStrip, deltaText, type QueueSnap } from "@/components/channels-view";
import { useConnections } from "@/components/providers";
import { Alert, Card, PageHeader, useIsClient } from "@/components/ui";
import { billingPickerDay, billingRequestQuery, disabledGatewayAmountText } from "@/lib/billing-query";
import { formatUsd } from "@/lib/format";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type OverviewStats = {
  total: number;
  running: number;
  anomaly: number;
  autoDisabled: number;
  pullFailed: number;
  upstreamMissing?: number;
  pausedGateways?: number;
  todayQuota: number;
  yesterdayQuota: number;
  queue: QueueSnap;
};

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
  typeName: string;
  type: number;
  testQuota: number;
  kind: string;
  label: string;
  finding: string;
  span: string;
  spanDays: number;
  backfillAt: number | null;
  gray: boolean;
  billingMode?: string;
  quality?: string;
  imported?: boolean;
  rebindFrom?: number | null;
  rebindTo?: number | null;
  oldSegmentStatus?: string;
};
type Bill = {
  copy: string;
  requestedDay: string | null;
  publication?: "latest" | "published" | "unpublished" | "none";
  collecting: boolean;
  progress: { total: number; ok: number; failed: number; etaMinutes?: number };
  suppliers: { id: string; name: string }[];
  publishedAt: number | null;
  publishedLabel: string;
  billDay: string | null;
  unsyncedCount: number;
  incomplete?: boolean;
  disabledGateway?: { channels: number; consumption: number | null; complete: boolean };
  totalConsumption: number;
  totalTestQuota: number;
  showTestLine?: boolean;
  remainingBalance: number;
  usedUsd: number;
  byType: Slice[];
  bySupplier: Slice[];
  byChannel: Slice[];
  byGroup: Slice[];
  trend: { day: string; label: string; spanDays: number; value: number; span: boolean }[];
  rows: BillRow[];
};
export type { Bill, BillRow };

/** Shared by the overview and the bills page. A picked day is the `day` query; an empty pick lets the server choose the latest published day. */
export function useBillingBill(options: { unsynced?: boolean; supplier?: string; intervalMs: number }) {
  const hydrated = useIsClient();
  const errors = useTranslations("errors");
  const [picked, setPicked] = useState<string | null>(null);
  const [urlReady, setUrlReady] = useState(false);
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("day")?.trim() ?? "";
    if (fromUrl) setPicked(fromUrl);
    setUrlReady(true);
  }, []);

  const pickerValue = billingPickerDay(picked, bill);

  useEffect(() => {
    if (!hydrated || !urlReady) return;
    let cancelled = false;
    const qs = billingRequestQuery({ day: picked, unsynced: options.unsynced, supplier: options.supplier });
    const load = () => {
      void fetch(`/api/billing${qs}`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) {
            if (!cancelled) setError(errors("billingLoadFailed"));
            return;
          }
          if (!cancelled) {
            setBill((await res.json()) as Bill);
            setError("");
          }
        })
        .catch(() => {
          if (!cancelled) setError(errors("billingLoadFailed"));
        });
    };
    load();
    const timer = window.setInterval(load, options.intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hydrated, urlReady, picked, options.unsynced, options.supplier, options.intervalMs, errors]);

  const chooseDay = (value: string) => {
    const next = value.trim();
    setPicked(next || null);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("day", next);
    else url.searchParams.delete("day");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  return { hydrated, bill, error, pickerValue, chooseDay };
}

export function BillDayControl({ value, onChange }: { value: string; onChange: (day: string) => void }) {
  const t = useTranslations("billing");
  return (
    <input
      type="date"
      className="h-9 rounded-control border-0 bg-input px-3 text-sm"
      value={value}
      aria-label={t("pickDay")}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function BillPeriod({ bill }: { bill: Bill }) {
  const t = useTranslations("billing");
  if (bill.publication === "unpublished") {
    return <span className="text-secondary">{t("unpublishedLine", { day: bill.requestedDay ?? "—" })}</span>;
  }
  if (bill.publication === "latest" && bill.billDay) {
    return <span className="text-secondary">{t("latestPublished", { day: bill.billDay })}</span>;
  }
  if (bill.publication === "none" || !bill.billDay) {
    return <span className="text-secondary">{t("nonePublished")}</span>;
  }
  return <span className="text-secondary">{t("periodLine", { day: bill.billDay })}</span>;
}

export function DisabledGatewayLine({ bill }: { bill: Bill }) {
  const t = useTranslations("billing");
  const locale = useLocale();
  if (!bill.disabledGateway?.channels) return null;
  return (
    <p className="text-sm text-muted">
      {t("disabledGatewayExcluded")}
      <span className="ml-2 tabular-nums">{disabledGatewayAmountText(bill.disabledGateway, (value) => formatUsd(value, locale), t("missingData"), t("incomplete"))}</span>
    </p>
  );
}

type BillingT = ReturnType<typeof useTranslations>;

/** 行标签：span2/spanN 合计、快照模式缺数据、未同步、无基线（账单页与总览共用）。 */
export function billLabelText(t: BillingT, row: { label: string; kind?: string; spanDays: number; billingMode?: string }): string {
  const raw = row.label;
  if (raw === "span2" || raw === "两日合计") return t("span2");
  if (raw === "spanN") return t("spanN", { count: row.spanDays });
  const counted = raw.match(/^(\d+)日合计$/);
  if (counted) return t("spanN", { count: Number(counted[1]) });
  if (row.billingMode === "snapshot" && row.kind !== "amount") return t("missingData");
  if (raw === "unsynced" || raw === "未同步" || row.kind === "unsynced") return t("unsynced");
  if (raw === "noBaseline" || raw === "无基线" || row.kind === "no-baseline") return t("noBaseline");
  if (raw === "oneDay" || raw === "一日" || !raw) return t("oneDay");
  return raw;
}

export function billFindingText(t: BillingT, finding: string): string {
  if (finding === "missing" || finding === "网关上找不到") return t("missing");
  if (finding === "anomaly" || finding === "异常") return t("anomaly");
  return finding;
}

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
  const t = useTranslations("billing");
  const ct = useTranslations("channels");
  const locale = useLocale();
  const { hydrated, bill, error, pickerValue, chooseDay } = useBillingBill({ intervalMs: 5000 });
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const admin = user?.role === "admin";

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void fetch("/api/channels?page=1", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { stats?: OverviewStats };
        if (!cancelled && body.stats) setOverview(body.stats);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hydrated]);

  if (!hydrated || !bill) return <p className="text-sm text-muted">{t("loading")}</p>;
  const money = (value: number) => formatUsd(value, locale);
  const noAmounts = Boolean(bill.incomplete) && bill.byType.length === 0;
  const totalLabel = noAmounts ? t("missingData") : money(bill.totalConsumption);
  const totalCaption = bill.incomplete ? t("incomplete") : t("usage");

  return (
    <div>
      <PageHeader title={t("title")} description={t("scope")} />
      {overview ? (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiRing label={ct("stats.total")} value={overview.total.toLocaleString(locale)} ratio={1} tone="#0A0A0A" hint="" />
            <KpiRing label={ct("stats.running")} value={overview.running.toLocaleString(locale)} ratio={overview.total ? overview.running / overview.total : 0} tone="#16A34A" hint={ct("stats.share", { percent: overview.total ? Math.round((overview.running / overview.total) * 1000) / 10 : 0 })} />
            <KpiRing
              label={ct("stats.anomaly")}
              value={overview.anomaly.toLocaleString(locale)}
              ratio={overview.total ? overview.anomaly / overview.total : 0}
              tone="#DC2626"
              hint={
                <span>
                  {ct("stats.anomalyAuto", { auto: overview.autoDisabled })}
                  {" · "}
                  {ct("stats.anomalyPull", { pull: overview.pullFailed })}
                  {" · "}
                  <span className="text-warn">{ct("stats.anomalyMissing", { missing: overview.upstreamMissing ?? 0 })}</span>
                </span>
              }
            />
            <KpiRing label={ct("stats.today")} value={formatUsd(overview.todayQuota, locale)} ratio={overview.yesterdayQuota > 0 ? Math.min(1, overview.todayQuota / overview.yesterdayQuota) : 1} tone="#FF9500" hint={ct("stats.yesterday", { amount: formatUsd(overview.yesterdayQuota, locale), delta: deltaText(overview.todayQuota, overview.yesterdayQuota) })} />
          </div>
          {overview.pausedGateways ? <p className="mb-3 text-sm text-muted">{ct("stats.pausedGateways", { count: overview.pausedGateways })}</p> : null}
          {admin ? <div className="mb-3"><QueueStrip queue={overview.queue} admin={admin} /></div> : null}
        </>
      ) : null}
      {error ? <div className="mb-4"><Alert tone="danger">{error}</Alert></div> : null}
      {bill.publication === "unpublished" ? <div className="mb-4"><Alert tone="info">{t("unpublishedHint", { day: bill.requestedDay ?? "—" })}</Alert></div> : null}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <BillDayControl value={pickerValue} onChange={chooseDay} />
        <BillPeriod bill={bill} />
        {bill.publishedAt && bill.publication !== "unpublished" ? <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok">{t("publishedPill")}</span> : null}
        {bill.publication !== "unpublished" && bill.collecting ? (
          <span className="whitespace-nowrap rounded-full bg-warn-soft px-3 py-1 text-warn">
            {bill.progress.etaMinutes ? t("collectingEta", { ok: bill.progress.ok, total: bill.progress.total, minutes: bill.progress.etaMinutes }) : t("collecting", { ok: bill.progress.ok, total: bill.progress.total })}
          </span>
        ) : null}
      </div>
      <div className="mb-4 grid items-stretch gap-3 xl:grid-cols-[minmax(0,1.5fr)_16rem]">
        <Donut title={t("byType")} slices={bill.byType} size={240} stroke={28} center={totalLabel} caption={totalCaption} empty={t("noData")} unknown={t("unknownSupplier")} money={money} />
        <Card className="px-4 py-4">
          <div className="text-xs text-secondary">{t("excluded")}</div>
          <div className="mt-1 text-2xl font-semibold">{bill.unsyncedCount}</div>
          <div className="mt-1 text-xs text-muted">{t("excludedHint")}</div>
        </Card>
      </div>
      <div className={`grid gap-3 ${admin ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
        {admin ? <Donut title={t("bySupplier")} slices={bill.bySupplier} size={168} stroke={18} center={totalLabel} caption={totalCaption} empty={t("noData")} unknown={t("unknownSupplier")} money={money} /> : null}
        <Donut title={t("byChannel")} slices={bill.byChannel} size={168} stroke={18} center={totalLabel} caption={totalCaption} empty={t("noData")} unknown={t("unknownSupplier")} money={money} />
        <Donut title={t("byGroup")} slices={bill.byGroup} size={168} stroke={18} center={totalLabel} caption={totalCaption} empty={t("noData")} unknown={t("unknownSupplier")} money={money} />
      </div>
      <div className="mt-3"><DisabledGatewayLine bill={bill} /></div>
    </div>
  );
}
