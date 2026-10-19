"use client";

import { ChannelDrawer, type DrawerChannel } from "@/components/channel-drawer";
import { useConnections } from "@/components/providers";
import { Alert, accentIndex, buttonClass, Card, ConfirmDialog, PageHeader, useIsClient } from "@/components/ui";
import { CHANNEL_ID_SEARCH_CAP, parseChannelKeyword, type ChannelSort } from "@/lib/channel-query";
import { formatQuota, formatTimestamp } from "@/lib/format";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

type GatewayOption = { id: string; name: string; demo: boolean; baseUrl?: string; disabled?: boolean };
type Creator = { id: string; name: string; username: string };
type ChannelItem = DrawerChannel & {
  upstreamId: number;
  typeName: string;
  beforeQuota: number | null;
  todayQuota: number | null;
  usedQuota: number;
  successRate: number | null;
  balance: number | null;
  autoDisabled: boolean;
  autoDisabledAt: number | null;
  creatorName: string;
  createdAt: number;
  lastSyncAt: number | null;
  syncStatus: string;
  syncError: string;
  responseTime: number | null;
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  lastTestError: string;
  autoDisableReason: string;
  createdHere: boolean;
  upstreamMissing: boolean;
};

type Counts = { all: number; enabled: number; running: number; manual: number; auto: number; disabled: number; anomaly: number };
export type QueueSnap = { hits: number; limit: number; inflight: number; concurrency: number; channelPerMin: number; ok: number; queued: number; backoff: number; throttled: number; failed: number; unsynced: number };
type Stats = {
  total: number;
  enabled: number;
  running: number;
  anomaly: number;
  autoDisabled: number;
  pullFailed: number;
  disabled: number;
  todayQuota: number;
  yesterdayQuota: number;
  queue: QueueSnap;
  sparklines: { total: number[]; enabled: number[]; disabled: number[]; today: number[] };
};

type ListResponse = {
  page: number;
  pageSize: number;
  total: number;
  items: ChannelItem[];
  groups: string[];
  creators: Creator[];
  gateways: GatewayOption[];
  types: { id: number; name: string }[];
  counts: Counts;
  stats: Stats;
  recognized: number;
  truncated: boolean;
};

type TestBody = { ok?: boolean; name?: string; latencyMs?: number; message?: string; model?: string };
type BulkItem = { id: string; name: string; reason: string };
type BulkBody = {
  error?: { message?: string };
  message?: string;
  pending?: boolean;
  tests?: TestBody[];
  redisabled?: number;
  redisabledItems?: BulkItem[];
  failedItems?: BulkItem[];
  ok?: number;
  fail?: number;
};

const TABS = [
  ["", "all"],
  ["running", "running"],
  ["disabled", "disabled"],
  ["anomaly", "anomaly"],
] as const;

function known(t: ReturnType<typeof useTranslations>, value: string | undefined, fallback: string): string {
  if (value && (t as unknown as { has: (key: string) => boolean }).has(value)) return t(value as never);
  return value || fallback;
}

export function ChannelsView() {
  const { ready, user } = useConnections();
  const hydrated = useIsClient();
  const t = useTranslations("channels");
  const common = useTranslations("common");
  const errors = useTranslations("errors");
  const locale = useLocale();
  const [gateway, setGateway] = useState("");
  const [keyword, setKeyword] = useState("");
  const [queryKeyword, setQueryKeyword] = useState("");
  const [loadedQuery, setLoadedQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [rebind, setRebind] = useState<ChannelItem | null>(null);
  const [rebindId, setRebindId] = useState("");
  const [group, setGroup] = useState("");
  const [creator, setCreator] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<ChannelSort>("id");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [nameBook, setNameBook] = useState<Record<string, string>>({});
  const [drawer, setDrawer] = useState<"add" | ChannelItem | null>(null);
  const [confirm, setConfirm] = useState<{ ids: string[]; enabled: boolean; names: string[] } | null>(null);
  const [bulk, setBulk] = useState<{ enabled: boolean; ok: number; fail: number; again: number; failed: BulkItem[]; againItems: BulkItem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [bump, setBump] = useState(0);
  const parsedKeyword = parseChannelKeyword(keyword);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (gateway) params.set("gateway", gateway);
    if (queryKeyword) params.set("keyword", queryKeyword);
    if (group) params.set("group", group);
    if (creator) params.set("creator", creator);
    if (status) params.set("status", status);
    if (type) params.set("type", type);
    if (sort !== "id") params.set("sort", sort);
    if (dir !== "desc") params.set("dir", dir);
    params.set("page", String(page));
    return params.toString();
  }, [gateway, queryKeyword, group, creator, status, type, sort, dir, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQueryKeyword(keyword), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void fetch(`/api/channels?${query}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          if (!cancelled) {
            setLoadError(known(errors, body?.error?.message, t("loadFailed")));
            setLoadedQuery(query);
          }
          return;
        }
        const body = (await res.json()) as ListResponse;
        if (cancelled) return;
        setData(body);
        setNameBook((current) => {
          const next = { ...current };
          for (const item of body.items) next[item.id] = item.name;
          return next;
        });
        setLoadError("");
        setLoadedQuery(query);
        setGateway((current) => current || body.gateways.find((item) => !item.disabled)?.id || body.gateways[0]?.id || "");
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(t("loadFailed"));
          setLoadedQuery(query);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ready, query, tick, bump, errors, t]);

  function describeTests(tests: TestBody[] | undefined): string {
    if (!tests?.length) return "";
    if (tests.length === 1) {
      const item = tests[0]!;
      return item.ok
        ? t("testOkNamed", { name: item.name || t("channelFallback"), ms: item.latencyMs ?? 0 })
        : t("testFailNamed", { name: item.name || t("channelFallback"), message: known(errors, item.message, "") });
    }
    const ok = tests.filter((item) => item.ok).length;
    return t("testSummary", { ok, fail: tests.length - ok });
  }

  async function saveDrawer(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const editing = drawer && drawer !== "add" ? drawer : null;
    const res = await fetch(editing ? `/api/channels/${editing.id}` : "/api/channels", {
      method: editing ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    const payload = (await res.json().catch(() => null)) as { error?: { message?: string }; message?: string; pending?: boolean; tests?: TestBody[]; duplicateKeys?: number } | null;
    if (!res.ok && res.status !== 202) {
      setError(known(errors, payload?.error?.message, errors("channelsSaveFailed")));
      return;
    }
    const tests = describeTests(payload?.tests);
    const dupes = payload?.duplicateKeys ? t("duplicateKeys", { count: payload.duplicateKeys }) : "";
    setNotice(payload?.pending ? known(errors, payload.message, errors("upstreamBusy")) : t("saved", { detail: `${tests}${dupes}` }));
    setDrawer(null);
    setPage(1);
    setBump((value) => value + 1);
  }

  async function applyStatus() {
    if (!confirm) return;
    setBusy(true);
    const res = await fetch("/api/channels/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: confirm.ids, enabled: confirm.enabled }),
    });
    setBusy(false);
    const body = (await res.json().catch(() => null)) as BulkBody | null;
    if (!res.ok && res.status !== 202) {
      setError(known(errors, body?.error?.message, errors("statusFailed")));
      return;
    }
    if (confirm.ids.length > 1 && !body?.pending) {
      setBulk({ enabled: confirm.enabled, ok: body?.ok ?? 0, fail: body?.fail ?? 0, again: body?.redisabled ?? 0, failed: body?.failedItems ?? [], againItems: body?.redisabledItems ?? [] });
    } else {
      const banned = body?.redisabledItems?.length
        ? body.redisabledItems.map((item) => t("redisabled", { name: item.name, reason: item.reason ? `${locale === "zh-CN" ? "：" : ": "}${item.reason}` : "" })).join(locale === "zh-CN" ? "；" : "; ")
        : "";
      const state = body?.pending ? known(errors, body.message, errors("upstreamBusy")) : confirm.enabled ? t("enabledNotice") : t("disabledNotice");
      setNotice([state, describeTests(body?.tests), banned].filter(Boolean).join(" · "));
    }
    setConfirm(null);
    setSelected([]);
    setBump((value) => value + 1);
  }

  async function testOne(id: string) {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/channels/${id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    setBusy(false);
    const body = (await res.json().catch(() => null)) as { error?: { message?: string }; message?: string; pending?: boolean; ok?: boolean; latencyMs?: number } | null;
    if (!res.ok && res.status !== 202) {
      setError(known(errors, body?.error?.message, errors("testIncomplete")));
      return;
    }
    if (body?.pending) setNotice(known(errors, body.message, errors("upstreamBusy")));
    else setNotice(body?.ok ? t("testOk", { ms: body.latencyMs ?? 0 }) : t("testFail", { message: known(errors, body?.message, "") }));
    setBump((value) => value + 1);
  }

  function toggleSort(key: "before" | "today" | "total") {
    setPage(1);
    if (sort === key) setDir((value) => (value === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir("desc");
    }
  }

  function testText(item: ChannelItem): string {
    if (!item.lastTestAt) return t("notTested");
    const head = item.lastTestOk ? t("testOk", { ms: item.responseTime ?? 0 }) : t("testFail", { message: known(errors, item.lastTestError, t("testError")) });
    return `${head} · ${formatTimestamp(item.lastTestAt, locale)}`;
  }

  function quota(value: number | null): string {
    return value === null ? common("dash") : formatQuota(value, locale);
  }

  if (!hydrated || !ready) return <ChannelSkeleton label={t("loading")} />;
  const items = data?.items ?? [];
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 20)));
  const allChecked = items.length > 0 && items.every((item) => selected.includes(item.id));
  const filtered = Boolean(keyword || group || creator || status || type);
  const loading = Boolean(data) && loadedQuery !== query;
  const columns = ([
    { key: "id", label: t("columns.id") },
    { key: "name", label: t("columns.name") },
    { key: "type", label: t("columns.type") },
    { key: "group", label: t("columns.group") },
    { key: "today", label: t("columns.today"), sort: "today" },
    { key: "total", label: t("columns.total"), sort: "total" },
    { key: "success", label: t("columns.success") },
    { key: "status", label: t("columns.status") },
    { key: "creator", label: t("columns.creator") },
    { key: "created", label: t("columns.created") },
    { key: "actions", label: t("columns.actions") },
  ] as { key: string; label: string; sort?: "before" | "today" | "total" }[]).filter((column) => column.key !== "creator" || user?.role === "admin");
  const selectedNames = selected.map((id) => nameBook[id] ?? items.find((item) => item.id === id)?.name ?? id);

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={user?.role === "supplier" ? t("supplierDescription") : t("description")}
      />
      {error ? <div className="mb-4"><Alert tone="danger">{error}</Alert></div> : null}
      {notice ? <div className="mb-4"><Alert tone="info">{notice}</Alert></div> : null}
      {loadError && data ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Alert tone="danger">{loadError}</Alert>
          <button type="button" className={buttonClass("secondary", "h-8")} onClick={() => setBump((value) => value + 1)}>{common("retry")}</button>
        </div>
      ) : null}
      {!data && loadError ? (
        <Card className="px-6 py-16 text-center">
          <p className="text-sm font-medium">{loadError}</p>
          <button type="button" className={buttonClass("primary", "mt-4")} onClick={() => setBump((value) => value + 1)}>{common("retry")}</button>
        </Card>
      ) : null}
      {!data && !loadError ? <ChannelSkeleton label={t("loading")} /> : null}
      {data ? (
        <>
          <Card className="mb-3 flex flex-col gap-3 p-3" aria-label={t("filtersLabel")}>
            <div className="flex flex-wrap items-center gap-2">
              <select className="h-9 max-w-60 rounded-control border-0 bg-input px-3 text-sm" value={gateway} onChange={(event) => { setGateway(event.target.value); setPage(1); setSelected([]); }} aria-label={t("gateway")}>
                {data.gateways.length ? null : <option value="">{t("noGateway")}</option>}
                {data.gateways.map((item) => {
                  const host = item.baseUrl ? item.baseUrl.replace(/^https?:\/\//, "") : "";
                  return <option key={item.id} value={item.id}>{item.name}{host ? ` · ${host}` : ""}{item.demo ? ` · ${common("demo")}` : ""}</option>;
                })}
              </select>
              <span title={gateway ? undefined : t("addDisabledTip")}>
                <button type="button" className={buttonClass("primary", "h-9")} onClick={() => setDrawer("add")} disabled={!gateway}>{t("add")}</button>
              </span>
              <div className="ml-auto">
                <button type="button" className={buttonClass("ghost", "h-9 text-sm")} onClick={() => setFiltersOpen((value) => !value)}>{filtersOpen ? t("collapse") : t("filtersCollapsed")}</button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ChipSearch value={keyword} placeholder={t("keywordPlaceholder")} recognized={parsedKeyword.recognized} onChange={(value) => { setKeyword(value); setPage(1); }} />
              {loading ? <span className="text-xs text-muted">{t("loading")}</span> : null}
              {data.truncated ? <span className="text-xs text-warn">{t("searchTruncated", { count: CHANNEL_ID_SEARCH_CAP })}</span> : null}
              {filtersOpen ? (
                <>
                  <select className="h-9 rounded-control border-0 bg-input px-3 text-sm" value={group} onChange={(event) => { setGroup(event.target.value); setPage(1); }} aria-label={t("group")}>
                    <option value="">{t("group")}</option>
                    {data.groups.map((item) => <option key={item}>{item}</option>)}
                  </select>
                  {user?.role === "admin" ? (
                    <select className="h-9 rounded-control border-0 bg-input px-3 text-sm" value={creator} onChange={(event) => { setCreator(event.target.value); setPage(1); }} aria-label={t("creator")}>
                      <option value="">{t("creator")}</option>
                      {data.creators.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  ) : null}
                  <select className="h-9 rounded-control border-0 bg-input px-3 text-sm" value={type} onChange={(event) => { setType(event.target.value); setPage(1); }} aria-label={t("type")}>
                    <option value="">{t("type")}</option>
                    {data.types.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  <button type="button" className={buttonClass("ghost", "h-9 text-sm")} onClick={() => { setKeyword(""); setGroup(""); setCreator(""); setType(""); setStatus(""); setPage(1); }}>{t("reset")}</button>
                </>
              ) : null}
            </div>
            <div className="inline-flex w-fit max-w-full flex-wrap rounded-full bg-input p-1" role="group" aria-label={t("status")}>
              {TABS.map(([value, key]) => (
                <button key={key} type="button" className={status === value ? "rounded-full bg-card px-3.5 py-1.5 text-sm font-semibold text-foreground shadow-sm" : "rounded-full px-3.5 py-1.5 text-sm text-secondary"} onClick={() => { setStatus(value); setPage(1); setSelected([]); }}>
                  {t(`tabs.${key}`)} {data.counts[key].toLocaleString(locale)}
                </button>
              ))}
            </div>
          </Card>
          <div className={`mb-3 flex flex-wrap items-center gap-3 rounded-control bg-primary-soft px-4 py-2 text-sm ${selected.length ? "" : "hidden"}`}>
            <span className="font-medium">{t("selected", { count: selected.length })}</span>
            <button type="button" className="font-medium" onClick={() => setConfirm({ ids: selected, enabled: true, names: selectedNames })}>{t("bulkEnable")}</button>
            <button type="button" className="font-medium" onClick={() => setConfirm({ ids: selected, enabled: false, names: selectedNames })}>{t("bulkDisable")}</button>
            <button type="button" className="text-secondary" onClick={() => setSelected([])}>{t("clear")}</button>
            <span className="text-xs text-muted">{t("pageOnly")}</span>
          </div>
          <Card>
            <div className="max-h-[calc(100vh-15rem)] overflow-auto">
              <table className="w-max min-w-full text-left text-sm">
                <thead className="sticky top-0 z-10 bg-card text-sm font-semibold text-secondary shadow-[0_1px_0_var(--border)]">
                  <tr>
                    <th className="whitespace-nowrap px-4 py-3"><input type="checkbox" checked={allChecked} onChange={(event) => setSelected(event.target.checked ? items.map((item) => item.id) : [])} aria-label={t("selectPage")} /></th>
                    {columns.map((column) => (
                      <th key={column.key} className="whitespace-nowrap px-4 py-3 font-medium" aria-sort={column.sort ? (sort === column.sort ? (dir === "asc" ? "ascending" : "descending") : "none") : undefined}>
                        {column.sort ? (
                          <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort(column.sort!)} aria-label={t("sortBy", { column: column.label })}>
                            {column.label}
                            <span className={sort === column.sort ? "text-foreground" : "text-muted"}>{sort === column.sort ? (dir === "asc" ? "↑" : "↓") : "↕"}</span>
                          </button>
                        ) : column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr><td colSpan={columns.length + 1} className="px-4 py-16 text-center">
                      {data.gateways.length ? (
                        <p className="text-sm font-semibold">{filtered ? t("emptyFiltered") : t("empty")}</p>
                      ) : (
                        <div className="mx-auto flex max-w-md flex-col items-center">
                          <div className="mb-4 flex items-center gap-2" aria-hidden>
                            <span className="h-8 w-8 rounded-[10px] bg-blue" />
                            <span className="h-8 w-8 rounded-[14px_10px_16px_12px] bg-orange" />
                            <span className="h-8 w-8 rounded-[10px] bg-teal" />
                          </div>
                          <p className="text-sm font-semibold text-foreground">{t("noGatewayYet")}</p>
                          <p className="mt-1 text-sm text-muted">{t("emptyContact")}</p>
                        </div>
                      )}
                      {data.gateways.length && !filtered ? <button type="button" className={buttonClass("primary", "mt-4")} onClick={() => setDrawer("add")}>{t("add")}</button> : null}
                    </td></tr>
                  ) : items.map((item) => {
                    const tone = item.upstreamMissing ? "warn" : item.status === "enabled" ? "ok" : item.autoDisabled ? "danger" : "manual";
                    const statusLabel = item.upstreamMissing ? t("missingUpstream") : item.status === "enabled" ? t("running") : item.autoDisabled ? common("autoDisabled") : t("manualDisabled");
                    const reasonText = item.autoDisableReason && item.autoDisableReason !== "autoDisabled" ? item.autoDisableReason : "";
                    const pill = tone === "ok" ? "bg-ok-soft text-ok" : tone === "danger" ? "bg-danger-soft text-danger" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-input text-secondary";
                    const dot = tone === "ok" ? "bg-ok" : tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : "bg-muted";
                    return (
                      <tr key={item.id} className="group border-t border-line hover:bg-hover">
                        <td className="px-4 py-3.5"><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} aria-label={t("selectRow", { name: item.name })} /></td>
                        <td className="whitespace-nowrap px-4 py-3.5 font-mono text-[13px] text-muted">#{item.upstreamId}</td>
                        <td className="whitespace-nowrap px-4 py-3.5 font-medium">{item.name}</td>
                        <td className="whitespace-nowrap px-4 py-3.5">
                          <span className="inline-flex items-center gap-2 text-sm">
                            <FamilyAvatar type={item.type} name={item.typeName} />
                            {item.typeName}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3.5"><GroupChip name={item.group} /></td>
                        <td className="whitespace-nowrap px-4 py-3.5 text-[13px] font-semibold tabular-nums">
                          <div>{quota(item.todayQuota)}</div>
                          <span className="mt-1 block h-[3px] w-14 overflow-hidden rounded-full bg-[#F0F0F0]"><span className="block h-full bg-foreground" style={{ width: `${todayShare(item.todayQuota, items)}%` }} /></span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3.5 text-[13px] tabular-nums">{quota(item.usedQuota)}</td>
                        <td className="whitespace-nowrap px-4 py-3.5 text-[13px] tabular-nums">
                          <span className={successTone(item.successRate)}>{item.successRate === null ? common("dash") : `${Math.round(item.successRate * 100)}%`}</span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3.5">
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${pill}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                            {statusLabel}
                          </span>
                          {item.autoDisabled && (reasonText || item.autoDisabledAt) ? (
                            <div className="mt-1 max-w-52 truncate text-xs text-muted" title={reasonText}>{[reasonText, item.autoDisabledAt ? formatTimestamp(item.autoDisabledAt, locale) : ""].filter(Boolean).join(" · ")}</div>
                          ) : null}
                          {item.upstreamMissing ? <div className="mt-1 text-xs text-muted">{t("missingId", { id: item.upstreamId })}</div> : null}
                          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                            <span className={`h-1.5 w-1.5 rounded-full ${item.syncStatus === "ok" ? "bg-ok" : "bg-warn"}`} />
                            {item.lastSyncAt ? t("updatedAgo", { when: formatTimestamp(item.lastSyncAt, locale) }) : t("notSynced")}
                          </div>
                        </td>
                        {user?.role === "admin" ? <td className="whitespace-nowrap px-4 py-3.5 text-[13px] text-secondary">{item.creatorName || t("unknownCreator")}</td> : null}
                        <td className="whitespace-nowrap px-4 py-3.5 text-[13px] text-muted">{formatTimestamp(item.createdAt, locale)}</td>
                        <td className="sticky right-0 whitespace-nowrap bg-card px-3 py-3.5 group-hover:bg-hover">
                          <div className="flex justify-end gap-0.5 opacity-70 transition group-hover:opacity-100 group-focus-within:opacity-100">
                            <button type="button" className={buttonClass("ghost", "h-7 px-2 text-xs")} onClick={() => void testOne(item.id)}>{t("test")}</button>
                            <button type="button" className={buttonClass("ghost", "h-7 px-2 text-xs")} onClick={() => setDrawer(item)}>{t("edit")}</button>
                            <button type="button" className={buttonClass("ghost", "h-7 px-2 text-xs")} onClick={() => setConfirm({ ids: [item.id], enabled: item.status !== "enabled", names: [`#${item.upstreamId} ${item.name}`] })}>{item.status === "enabled" ? t("disable") : t("enable")}</button>
                            {user?.role === "admin" && item.upstreamMissing ? <button type="button" className={buttonClass("ghost", "h-7 px-2 text-xs")} onClick={() => { setRebind(item); setRebindId(""); }}>{t("rebind")}</button> : null}
                          </div>
                          <div className="mt-0.5 max-w-64 truncate text-right text-xs text-muted" title={testText(item)}>{testText(item)}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-secondary">
              <span>{t("count", { total: data.total })}</span>
              <div className="flex flex-wrap items-center gap-1">
                {pageList(page, pageCount).map((item) => (
                  <button key={item} type="button" className={item === page ? "inline-flex h-8 w-8 items-center justify-center rounded-control bg-card text-sm font-semibold text-foreground shadow-sm" : "inline-flex h-8 w-8 items-center justify-center rounded-control bg-input text-sm text-secondary"} onClick={() => { setPage(item); setSelected([]); }}>
                    {item}
                  </button>
                ))}
              </div>
              <span>{t("perPage")}</span>
            </div>
          </Card>
        </>
      ) : null}
      {drawer ? (
        <ChannelDrawer
          key={drawer === "add" ? "add" : drawer.id}
          gatewayId={gateway}
          editing={drawer === "add" ? null : drawer}
          busy={busy}
          onClose={() => setDrawer(null)}
          onSave={saveDrawer}
          onTest={async (id, model) => {
            setBusy(true);
            const res = await fetch(`/api/channels/${id}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
            setBusy(false);
            const body = (await res.json().catch(() => null)) as { error?: { message?: string }; ok?: boolean; latencyMs?: number; message?: string } | null;
            setNotice(!res.ok ? known(errors, body?.error?.message, errors("testIncomplete")) : body?.ok ? t("testOk", { ms: body.latencyMs ?? 0 }) : t("testFail", { message: known(errors, body?.message, "") }));
            setBump((value) => value + 1);
          }}
        />
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={confirm.names.length > 1 ? (confirm.enabled ? t("confirmBulkEnableTitle") : t("confirmBulkDisableTitle")) : confirm.enabled ? t("confirmEnableTitle") : t("confirmDisableTitle")}
          body={confirm.names.length > 1 ? (confirm.enabled ? t("confirmBulkEnable", { count: confirm.names.length }) : t("confirmBulkDisable", { count: confirm.names.length })) : confirm.enabled ? t("confirmEnable", { name: confirm.names[0] ?? "" }) : t("confirmDisable", { name: confirm.names[0] ?? "" })}
          confirmLabel={confirm.names.length > 1 ? (confirm.enabled ? t("bulkEnable") : t("bulkDisable")) : confirm.enabled ? t("enable") : t("disable")}
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() => void applyStatus()}
        />
      ) : null}
      {bulk ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/35 p-4 sm:items-center">
          <div className="w-full max-w-[560px] rounded-[20px] border border-line bg-card p-5 shadow-sm" role="dialog" aria-labelledby="bulk-summary-title">
            <h2 id="bulk-summary-title" className="text-lg font-semibold">{bulk.enabled ? t("bulkEnableDone") : t("bulkDisableDone")}</h2>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-control bg-ok-soft px-2 py-3"><div className="text-xs text-secondary">{t("bulkOk")}</div><div className="text-2xl font-semibold text-ok">{bulk.ok}</div></div>
              <div className="rounded-control bg-danger-soft px-2 py-3"><div className="text-xs text-secondary">{t("bulkFail")}</div><div className="text-2xl font-semibold text-danger">{bulk.fail}</div></div>
              <div className="rounded-control bg-warn-soft px-2 py-3"><div className="text-xs text-secondary">{t("bulkAgain")}</div><div className="text-2xl font-semibold text-warn">{bulk.again}</div></div>
            </div>
            {[...bulk.failed, ...bulk.againItems].length ? (
              <table className="mt-4 w-full text-left text-sm">
                <thead className="text-xs text-muted"><tr><th className="py-1 font-medium">{t("bulkColChannel")}</th><th className="py-1 font-medium">{t("bulkColResult")}</th><th className="py-1 font-medium">{t("bulkColReason")}</th></tr></thead>
                <tbody>
                  {bulk.failed.map((item) => (
                    <tr key={`f-${item.id}`} className="border-t border-line"><td className="py-2">{item.name}</td><td className="py-2 text-danger">{t("bulkFail")}</td><td className="py-2 text-xs">{known(errors, item.reason, item.reason)}</td></tr>
                  ))}
                  {bulk.againItems.map((item) => (
                    <tr key={`a-${item.id}`} className="border-t border-line"><td className="py-2">{item.name}</td><td className="py-2 text-warn">{t("bulkAgain")}</td><td className="py-2 text-xs">{item.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className={buttonClass("secondary")} onClick={() => setBulk(null)}>{t("bulkClose")}</button>
              <button type="button" className={buttonClass("primary")} disabled={bulk.fail === 0} onClick={() => { const ids = bulk.failed.map((item) => item.id); const names = bulk.failed.map((item) => item.name); const enabled = bulk.enabled; setBulk(null); setConfirm({ ids, enabled, names }); }}>{t("bulkRetry", { count: bulk.fail })}</button>
            </div>
          </div>
        </div>
      ) : null}
      {rebind ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/35 p-4 sm:items-center">
          <form className="w-full max-w-md rounded-[20px] bg-card p-5" onSubmit={(event) => { event.preventDefault(); void (async () => {
            setBusy(true);
            const res = await fetch(`/api/channels/${rebind.id}/rebind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newapiChannelId: Number(rebindId) }) });
            setBusy(false);
            const body = (await res.json().catch(() => null)) as { error?: { message?: string }; from?: number; to?: number } | null;
            if (!res.ok) {
              setError(body?.error?.message || errors("bindingFailed"));
              return;
            }
            setNotice(t("rebound", { from: body?.from ?? rebind.upstreamId, to: body?.to ?? rebindId }));
            setRebind(null);
            setBump((value) => value + 1);
          })(); }}>
            <h2 className="text-base font-semibold">{t("rebindTitle", { name: rebind.name })}</h2>
            <p className="mt-2 text-xs leading-5 text-muted">{t("rebindHint")}</p>
            <input className="mt-3 h-11 w-full rounded-control bg-input px-3 text-sm outline-none focus:ring-2 focus:ring-foreground/15" inputMode="numeric" value={rebindId} placeholder={t("rebindPlaceholder")} onChange={(event) => setRebindId(event.target.value)} />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={buttonClass("secondary")} onClick={() => setRebind(null)}>{common("cancel")}</button>
              <button type="submit" className={buttonClass("primary")} disabled={busy || !/^\d+$/.test(rebindId)}>{t("rebind")}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

const CHIP = ["bg-green", "bg-pink", "bg-brown", "bg-red", "bg-cyan", "bg-orange", "bg-blue", "bg-purple"] as const;

function GroupChip({ name }: { name: string }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium text-accent-foreground ${CHIP[accentIndex(name || "default")]}`}>{name || "—"}</span>;
}

function pageList(page: number, pageCount: number): number[] {
  const width = 5;
  const start = Math.max(1, Math.min(page - 2, pageCount - width + 1));
  const end = Math.min(pageCount, start + width - 1);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function deltaText(today: number, yesterday: number): string {
  if (!yesterday) return "—";
  const pct = ((today - yesterday) / Math.abs(yesterday)) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function todayShare(value: number | null, items: ChannelItem[]): number {
  const max = Math.max(1, ...items.map((item) => Math.max(0, item.todayQuota ?? 0)));
  return Math.round((Math.max(0, value ?? 0) / max) * 100);
}

function successTone(rate: number | null): string {
  if (rate === null) return "text-muted";
  if (rate < 0.7) return "text-danger";
  if (rate < 0.9) return "text-warn";
  return "text-ok";
}

function familyOf(type: number): { letter: string; color: string } {
  if (type === 14) return { letter: "A", color: "#A2845E" };
  if (type === 1 || type === 3) return { letter: type === 3 ? "Z" : "O", color: "#34C759" };
  if (type === 24 || type === 41) return { letter: type === 41 ? "V" : "G", color: "#007AFF" };
  if (type === 43) return { letter: "D", color: "#30B0C7" };
  if (type === 42) return { letter: "M", color: "#FF9500" };
  if (type === 25) return { letter: "K", color: "#AF52DE" };
  return { letter: "•", color: "#8A8A8A" };
}

function FamilyAvatar({ type, name }: { type: number; name: string }) {
  const family = familyOf(type);
  return <span className="inline-flex h-5 w-5 items-center justify-center rounded-[6px] text-[10px] font-semibold text-white" style={{ background: family.color }} title={name}>{family.letter}</span>;
}

export function KpiRing({ label, value, ratio, tone, hint }: { label: string; value: string; ratio: number; tone: string; hint: string }) {
  const radius = 16;
  const turn = 2 * Math.PI * radius;
  const filled = turn * Math.max(0, Math.min(1, ratio));
  return (
    <Card className="flex items-center gap-3 px-4 py-3">
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden>
        <circle cx="22" cy="22" r={radius} fill="none" stroke="#F0F0F0" strokeWidth="5" />
        <circle cx="22" cy="22" r={radius} fill="none" stroke={tone} strokeWidth="5" strokeDasharray={`${filled} ${turn - filled}`} strokeLinecap="round" transform="rotate(-90 22 22)" />
      </svg>
      <div className="min-w-0">
        <p className="text-xs text-secondary">{label}</p>
        <p className="truncate text-lg font-semibold tabular-nums">{value}</p>
        <p className="truncate text-[11px] text-muted">{hint}</p>
      </div>
    </Card>
  );
}

export function QueueStrip({ queue, admin }: { queue: QueueSnap; admin: boolean }) {
  const t = useTranslations("channels");
  const ratio = queue.limit ? Math.min(1, queue.hits / queue.limit) : 0;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[14px] bg-card px-4 py-2 text-xs text-secondary">
      <span className="font-medium text-foreground">{t("queue.title", { hits: queue.hits, limit: queue.limit, inflight: queue.inflight, concurrency: queue.concurrency })}</span>
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-[#F0F0F0]"><span className="block h-full" style={{ width: `${ratio * 100}%`, background: ratio >= 0.9 ? "#FF9500" : "#0A0A0A" }} /></span>
      <span className="text-ok">{t("queue.ok", { count: queue.ok })}</span>
      <span className="text-teal">{t("queue.queued", { count: queue.queued })}</span>
      <span className="text-warn">{t("queue.backoff", { count: queue.backoff })}</span>
      <span className="text-brown">{t("queue.throttled", { count: queue.throttled })}</span>
      <span className="text-danger">{t("queue.failed", { count: queue.failed })}</span>
      <span className="text-muted">{t("queue.unsynced", { count: queue.unsynced })}</span>
      <span className="ml-auto text-muted">{admin ? t("queue.limitAdmin", { per: queue.channelPerMin }) : t("queue.supplierLimit")}</span>
    </div>
  );
}

function ChipSearch({ value, placeholder, recognized, onChange }: { value: string; placeholder: string; recognized: number; onChange: (value: string) => void }) {
  const t = useTranslations("channels");
  const parsed = parseChannelKeyword(value);
  const chips = parsed.ids;
  return (
    <div className="flex min-w-64 flex-1 flex-wrap items-center gap-1 rounded-control bg-input px-2 py-1">
      {chips.slice(0, 8).map((id) => (
        <button key={id} type="button" className="rounded-full bg-card px-2 py-0.5 text-xs" onClick={() => onChange(value.replace(new RegExp(`(^|[^\\d])${id}(?!\\d)`), "$1").replace(/\s{2,}/g, " ").trim())}>#{id} ×</button>
      ))}
      {chips.length > 8 ? <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">{t("idCount", { count: chips.length })}</span> : null}
      <input className="h-7 min-w-32 flex-1 bg-transparent text-sm outline-none" value={parsed.text || parsed.names.join(" ")} placeholder={chips.length ? "" : placeholder} onChange={(event) => onChange([chips.join(","), event.target.value].filter(Boolean).join(chips.length ? ", " : ""))} />
      {recognized > 1 ? <span className="text-xs text-secondary">{t("recognizedSearch", { count: recognized })}</span> : null}
    </div>
  );
}

function ChannelSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-16 animate-pulse rounded-card bg-input" />)}
      </div>
      <Card className="p-4">
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-control bg-input" />
          ))}
        </div>
      </Card>
    </div>
  );
}
