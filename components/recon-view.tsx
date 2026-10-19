"use client";

import { useConnections } from "@/components/providers";
import { Alert, buttonClass, Card, fieldClass, PageHeader, useIsClient } from "@/components/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type Adjustment = { id: string; amountQuota: number; note: string; createdAt: number };
type Node = {
  id: string;
  kind: "gateway" | "group" | "channel";
  name: string;
  billDay: string;
  spanLabel: string;
  ours: number | null;
  logs: number | null;
  delta: number | null;
  deltaPct: number | null;
  status: "match" | "anomaly" | "pending" | "unsynced" | "missing_logs";
  reason: string;
  quotaPerUnit: number;
  supplierAction: string;
  supplierNote: string;
  adminResolution: string;
  adminNote: string;
  adjustments: Adjustment[];
  locked: boolean;
  children: Node[];
};
type Page = {
  month: string;
  months: string[];
  locked: boolean;
  tolerancePct: number;
  quotaPerUnit: number;
  counts: { match: number; anomaly: number; pending: number; unsynced: number; missingLogs: number };
  gateways: Node[];
  missing?: { id: string; name: string; upstreamId: number; gatewayName: string; owner: string }[];
  manualTolerancePct?: number;
};

const COLORS: Record<string, string> = {
  match: "#34C759",
  anomaly: "#FF3B30",
  pending: "#FF9500",
  unsynced: "#C7C7CC",
  missing_logs: "#A2845E",
};

export function ReconView() {
  const { user } = useConnections();
  const hydrated = useIsClient();
  const t = useTranslations("recon");
  const errors = useTranslations("errors");
  const locale = useLocale();
  const [month, setMonth] = useState("");
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<{ id: string; action: "dispute" | "resolve" | "adjust"; note: string; amount: string } | null>(null);
  const [tab, setTab] = useState<"daily" | "supplier">("daily");
  const [grain, setGrain] = useState<"month" | "week">("month");
  const [rebind, setRebind] = useState<{ id: string; name: string } | null>(null);
  const [rebindId, setRebindId] = useState("");

  async function load(next = month) {
    const res = await fetch(`/api/recon${next ? `?month=${encodeURIComponent(next)}` : ""}`, { cache: "no-store" });
    if (!res.ok) {
      setError(errors("billingLoadFailed"));
      return;
    }
    const body = (await res.json()) as Page;
    setData(body);
    setMonth(body.month);
    setError("");
  }

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => void load(""), 0);
    return () => window.clearTimeout(timer);
    // The first read uses the latest published month.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  async function act(body: Record<string, unknown>) {
    const res = await fetch("/api/recon", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) {
      setError(payload?.error?.message || errors("reconAction"));
      return;
    }
    setNotice(t("saved"));
    setDraft(null);
    await load(month);
  }

  if (!hydrated || !data) return <p className="text-sm text-muted">{t("loading")}</p>;
  const admin = user?.role === "admin";
  const pendingLabel = tab === "daily" ? t("pendingWork") : t("pending");
  const slices = [
    ["match", data.counts.match, t("match")],
    ["anomaly", data.counts.anomaly, t("anomaly")],
    ["pending", data.counts.pending, pendingLabel],
    ["unsynced", data.counts.unsynced, t("unsynced")],
    ["missing_logs", data.counts.missingLogs, t("missingLogs")],
  ] as const;
  const checked = data.counts.match + data.counts.anomaly + data.counts.pending + data.counts.unsynced + data.counts.missingLogs;

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description", { tolerance: data.tolerancePct })}
        extra={
          <div className="flex flex-wrap items-center gap-2">
            {month ? <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok">{t("checked")}</span> : null}
            {tab === "daily" && admin ? <button type="button" className={buttonClass("primary", "h-9 text-sm")} disabled={!month || data.locked} onClick={() => void act({ action: "lock", month })}>{data.locked ? t("locked") : t("lock")}</button> : null}
          </div>
        }
      />
      <div className="mb-4 inline-flex rounded-full bg-input p-1">
        <button type="button" className={tab === "daily" ? "rounded-full bg-card px-3 py-1 text-xs font-semibold text-foreground shadow-sm" : "rounded-full px-3 py-1 text-xs text-secondary"} onClick={() => setTab("daily")}>{t("dailyTab")}</button>
        <button type="button" className={tab === "supplier" ? "rounded-full bg-card px-3 py-1 text-xs font-semibold text-foreground shadow-sm" : "rounded-full px-3 py-1 text-xs text-secondary"} onClick={() => setTab("supplier")}>{t("supplierTab")}</button>
      </div>
      {tab === "supplier" ? (
        <Card className="mb-4 flex flex-wrap items-center gap-2 p-3">
          <div className="inline-flex rounded-control bg-input p-1" role="group" aria-label={t("periodLabel")}>
            <button type="button" className={grain === "month" ? "h-7 rounded-[10px] bg-card px-3 text-xs font-semibold shadow-sm" : "h-7 rounded-[10px] px-3 text-xs text-secondary"} onClick={() => setGrain("month")}>{t("periodMonth")}</button>
            <button type="button" className={grain === "week" ? "h-7 rounded-[10px] bg-card px-3 text-xs font-semibold shadow-sm" : "h-7 rounded-[10px] px-3 text-xs text-secondary"} onClick={() => { setGrain("week"); setNotice(t("comingSoon")); }}>{t("periodWeek")}</button>
          </div>
          <select className="h-9 rounded-control border-0 bg-input px-3 text-sm" value={month} aria-label={t("periodLabel")} onChange={(event) => { setMonth(event.target.value); void load(event.target.value); }}>
            {data.months.length === 0 ? <option value="">{t("nonePublished")}</option> : data.months.map((item) => <option key={item}>{item}</option>)}
          </select>
          {grain === "week" ? <span className="text-xs text-muted">{t("comingSoon")}</span> : null}
          <a className={buttonClass("secondary", "h-9 text-sm")} href="/api/recon/template">{t("downloadTemplate")}</a>
          <button type="button" className={buttonClass("secondary", "h-9 text-sm")} onClick={() => setNotice(t("comingSoon"))}>{t("uploadCsv")}</button>
          <button type="button" className={buttonClass("secondary", "h-9 text-sm")} onClick={() => setNotice(t("comingSoon"))}>{t("manualEntry")}</button>
          <a className={buttonClass("secondary", "h-9 text-sm")} href={`/api/recon/export?month=${encodeURIComponent(month)}`}>{t("export")}</a>
        </Card>
      ) : (
        <div className="mb-4">
          <select className="h-9 rounded-control border-0 bg-input px-3 text-sm" value={month} aria-label={t("month")} onChange={(event) => { setMonth(event.target.value); void load(event.target.value); }}>
            {data.months.length === 0 ? <option value="">{t("nonePublished")}</option> : data.months.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
      )}
      {data.missing?.length ? (
        <Card className="mb-4 p-4">
          <h2 className="text-sm font-medium">{t("missingTitle", { count: data.missing.length })}</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {data.missing.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>#{item.upstreamId} {item.name} · {item.gatewayName} · {item.owner}</span>
                {admin ? (
                  <span className="flex gap-2">
                    <button type="button" className={buttonClass("secondary", "h-8")} onClick={() => { setRebind(item); setRebindId(""); }}>{t("rebind")}</button>
                    <button type="button" className={buttonClass("ghost", "h-8")} onClick={() => void fetch(`/api/channels/${item.id}/rebind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "mark" }) }).then(() => load(month))}>{t("markHandled")}</button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {error ? <div className="mb-4"><Alert tone="danger">{error}</Alert></div> : null}
      {notice ? <div className="mb-4"><Alert tone="info">{notice}</Alert></div> : null}
      <Card className="mb-4 p-4">
        <h2 className="text-sm font-semibold">{t("donut")}</h2>
        <div className="mt-3 flex flex-wrap items-start gap-6">
          <Donut total={checked} matched={data.counts.match} slices={slices.map(([key, value, label]) => ({ key, value, color: COLORS[key] ?? "#71717A", label }))} centre={t("centre", { matched: data.counts.match, total: checked })} />
          <div className="min-w-56 flex-1 space-y-2 text-sm">
            {slices.map(([key, , label]) => (
              <div key={key} className="flex gap-2">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: COLORS[key] }} />
                <div>
                  <div className="font-medium">{label}</div>
                  <p className="text-xs leading-5 text-muted">{t(`defs.${key}`)}</p>
                </div>
              </div>
            ))}
            <p className="text-xs leading-5 text-muted">{t("spanNote")}</p>
          </div>
        </div>
      </Card>
      {tab === "supplier" ? <p className="mb-3 text-xs text-muted">{t("manualHint", { tolerance: data.manualTolerancePct ?? 2 })}</p> : null}
      {data.gateways.length === 0 ? <Card className="px-4 py-16 text-center text-sm text-muted">{data.months.length ? t("empty") : t("nonePublished")}</Card> : (
        <div className="space-y-3">
          <div className="hidden grid-cols-[minmax(12rem,1.6fr)_repeat(5,minmax(5rem,1fr))] gap-2 px-4 text-xs font-medium text-muted md:grid">
            <span>{t("columns.name")}</span>
            <span>{t("columns.ours")}</span>
            <span>{t("columns.log")}</span>
            <span>{t("columns.delta")}</span>
            <span>{t("columns.pct")}</span>
            <span>{t("columns.status")}</span>
          </div>
          {data.gateways.map((gateway) => (
            <Card key={gateway.id} className="overflow-hidden">
              <RowLine node={gateway} locale={locale} emphasize pendingLabel={pendingLabel} />
              {gateway.children.map((group) => (
                <div key={group.id}>
                  <RowLine node={group} locale={locale} indent={1} pendingLabel={pendingLabel} />
                  {group.children.map((row) => (
                    <div key={row.id} className="border-t border-line">
                      <RowLine node={row} locale={locale} indent={2} pendingLabel={pendingLabel} />
                      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pl-16 text-xs text-secondary">
                        {row.reason.split(",").filter(Boolean).map((code) => <span key={code}>{reasonText(t, code)}</span>)}
                        {row.spanLabel ? <span>{t("spanKept")}</span> : null}
                        {row.supplierAction === "confirmed" ? <span>{t("confirmed")}</span> : null}
                        {row.supplierNote ? <span>{row.supplierNote}</span> : null}
                        {row.adminResolution ? <span>{t("resolved")}{row.adminNote ? ` · ${row.adminNote}` : ""}</span> : null}
                        {row.adjustments.map((item) => <span key={item.id}>{t("adjustment", { amount: money(item.amountQuota, row.quotaPerUnit, locale) })} {item.note}</span>)}
                        {!admin && !row.locked ? (
                          <>
                            <button type="button" className={buttonClass("ghost", "h-7 px-2")} onClick={() => void act({ action: "confirm", id: row.id })}>{t("confirm")}</button>
                            <button type="button" className={buttonClass("ghost", "h-7 px-2")} onClick={() => setDraft({ id: row.id, action: "dispute", note: "", amount: "" })}>{t("dispute")}</button>
                          </>
                        ) : null}
                        {admin && row.supplierAction === "disputed" && !row.adminResolution && !row.locked ? (
                          <button type="button" className={buttonClass("ghost", "h-7 px-2")} onClick={() => setDraft({ id: row.id, action: "resolve", note: "", amount: "" })}>{t("resolve")}</button>
                        ) : null}
                        {admin ? <button type="button" className={buttonClass("ghost", "h-7 px-2")} onClick={() => setDraft({ id: row.id, action: "adjust", note: "", amount: "" })}>{t("adjust")}</button> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </Card>
          ))}
        </div>
      )}
      {draft ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-4 sm:items-center">
          <form className="w-full max-w-md rounded-card border border-line bg-card p-5" onSubmit={(event) => { event.preventDefault(); void act({ action: draft.action, id: draft.id, note: draft.note, amountQuota: Number(draft.amount) }); }}>
            <h2 className="text-base font-semibold">{t(draft.action === "dispute" ? "disputeTitle" : draft.action === "resolve" ? "resolveTitle" : "adjustTitle")}</h2>
            {draft.action === "adjust" ? <p className="mt-2 text-xs text-muted">{t("adjustHint")}</p> : null}
            {draft.action === "adjust" ? <input className={`${fieldClass} mt-3`} inputMode="decimal" value={draft.amount} placeholder={t("amount")} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /> : null}
            <textarea className={`${fieldClass} mt-3 h-24 py-2`} value={draft.note} placeholder={t("note")} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={buttonClass("secondary")} onClick={() => setDraft(null)}>{t("cancel")}</button>
              <button type="submit" className={buttonClass("primary")}>{t("save")}</button>
            </div>
          </form>
        </div>
      ) : null}
      {rebind ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 p-4">
          <form className="w-full max-w-md rounded-[20px] bg-card p-5" onSubmit={(event) => { event.preventDefault(); void fetch(`/api/channels/${rebind.id}/rebind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newapiChannelId: Number(rebindId) }) }).then(async (res) => { const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null; if (!res.ok) { setError(body?.error?.message || errors("bindingFailed")); return; } setRebind(null); setNotice(t("saved")); await load(month); }); }}>
            <h2 className="text-base font-semibold">{t("rebind")} · {rebind.name}</h2>
            <p className="mt-2 text-xs text-muted">{t("rebindReject")}</p>
            <input className={`${fieldClass} mt-3`} value={rebindId} inputMode="numeric" onChange={(event) => setRebindId(event.target.value)} />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={buttonClass("secondary")} onClick={() => setRebind(null)}>{t("cancel")}</button>
              <button type="submit" className={buttonClass("primary")}>{t("rebind")}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function money(quota: number | null, unit: number, locale: string): string {
  if (quota === null) return "—";
  const per = unit > 0 ? unit : 500000;
  return (quota / per).toLocaleString(locale === "en" ? "en-US" : "zh-CN", { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" });
}

function percent(value: number | null, locale: string): string {
  if (value === null) return "—";
  return value.toLocaleString(locale, { style: "percent", maximumFractionDigits: 2 });
}

function reasonText(t: ReturnType<typeof useTranslations>, code: string): string {
  const known = ["reset", "self", "tolerance", "disabled_growth", "zero_streak", "purged", "timeout", "missing", "unread"];
  if (!known.includes(code)) return code;
  return t(`reasons.${code}` as "reasons.reset");
}

function RowLine({ node, locale, indent = 0, emphasize = false, pendingLabel }: { node: Node; locale: string; indent?: number; emphasize?: boolean; pendingLabel: string }) {
  const t = useTranslations("recon");
  const label = node.kind === "channel" ? `${node.name}${node.billDay ? ` · ${node.billDay}` : ""}` : node.name;
  return (
    <div className={`grid grid-cols-[minmax(12rem,1.6fr)_repeat(5,minmax(5rem,1fr))] items-center gap-2 px-4 py-3 text-sm ${emphasize ? "bg-input font-medium" : ""}`} style={{ paddingLeft: `${16 + indent * 16}px` }}>
      <div className="truncate">{label}</div>
      {node.kind === "channel" ? (
        <>
          <div className="whitespace-nowrap text-xs">{money(node.ours, node.quotaPerUnit, locale)}</div>
          <div className="whitespace-nowrap text-xs">{money(node.logs, node.quotaPerUnit, locale)}</div>
          <div className="whitespace-nowrap text-xs">{money(node.delta, node.quotaPerUnit, locale)}</div>
          <div className="whitespace-nowrap text-xs">{percent(node.deltaPct, locale)}</div>
          <div><StatusPill status={node.status} label={node.status === "pending" ? pendingLabel : node.status === "missing_logs" ? t("missingLogs") : t(node.status)} /></div>
        </>
      ) : <div className="col-span-5" />}
    </div>
  );
}

function StatusPill({ status, label }: { status: string; label: string }) {
  const tone = status === "match" ? "bg-ok-soft text-ok" : status === "anomaly" ? "bg-danger-soft text-danger" : status === "pending" ? "bg-warn-soft text-warn" : "";
  const dot = status === "match" ? "#16A34A" : status === "anomaly" ? "#DC2626" : status === "pending" ? "#D97706" : status === "missing_logs" ? "#A2845E" : "#C7C7CC";
  const custom = status === "missing_logs" || status === "unsynced";
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tone}`} style={custom ? { background: status === "missing_logs" ? "#F3EEE6" : "#F2F2F4", color: status === "missing_logs" ? "#A2845E" : "#6B6B70" } : undefined}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
      {label}
    </span>
  );
}

function Donut({ slices, centre }: { slices: { key: string; value: number; color: string; label: string }[]; total: number; matched: number; centre: string }) {
  const total = slices.reduce((sum, item) => sum + item.value, 0);
  const r = 88;
  const c = 2 * Math.PI * r;
  const arcs = slices.reduce<{ key: string; color: string; sweep: number; offset: number }[]>((list, slice) => {
    const sweep = total > 0 ? (slice.value / total) * c : 0;
    const offset = list.reduce((sum, item) => sum + item.sweep, 0);
    list.push({ key: slice.key, color: slice.color, sweep, offset });
    return list;
  }, []);
  return (
    <svg width="200" height="200" viewBox="0 0 200 200" className="shrink-0" role="img">
      <circle cx="100" cy="100" r={r} fill="none" stroke="#F0F0F0" strokeWidth="24" />
      {arcs.map((slice) => (
        <circle key={slice.key} cx="100" cy="100" r={r} fill="none" stroke={slice.color} strokeWidth="24" strokeDasharray={`${slice.sweep} ${c}`} strokeDashoffset={-slice.offset} transform="rotate(-90 100 100)" />
      ))}
      <text x="100" y="104" textAnchor="middle" fontSize="16" fontWeight="700" fill="#0A0A0A">{centre}</text>
    </svg>
  );
}
