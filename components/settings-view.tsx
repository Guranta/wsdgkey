"use client";

import { useConnections } from "@/components/providers";
import { BRAND_NAME } from "@/lib/brand";
import { gatewayCardCopy, settingsIntroKey } from "@/lib/gateway-card";
import { suggestSellerGatewayName } from "@/lib/seller-name";
import { formatShanghaiTime } from "@/lib/shanghai";
import { Alert, buttonClass, Card, fieldClass, PageHeader, useIsClient } from "@/components/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type Gateway = {
  id: string;
  name: string;
  baseUrl: string;
  adminUserId: string;
  demo: boolean;
  tokenSet: boolean;
  tokenMasked?: string;
  disabled?: boolean;
  channelCount?: number;
  lastSyncAt?: number | null;
  kind?: "newapi_admin" | "newapi_seller" | "newapi_supplier";
  username?: string;
  authStatus?: string;
  authError?: string;
  authCheckedAt?: number | null;
  accessExpiresAt?: number | null;
};
type Limits = { siteName: string; gatewayPerMin: number; channelPerMin: number; concurrency: number; testCooldownMin: number; quotaPerUnit: number; reconTolerancePct: number; zeroDays: number; manualTolerancePct: number };
type Draft = { id: string; kind: "newapi_admin" | "newapi_seller" | "newapi_supplier"; name: string; baseUrl: string; adminUserId: string; token: string; username: string; password: string; nameTouched: boolean };

const EMPTY: Limits = { siteName: BRAND_NAME, gatewayPerMin: 60, channelPerMin: 5, concurrency: 3, testCooldownMin: 10, quotaPerUnit: 500000, reconTolerancePct: 1, zeroDays: 3, manualTolerancePct: 2 };
const BLANK: Draft = { id: "", kind: "newapi_admin", name: "", baseUrl: "", adminUserId: "1", token: "", username: "", password: "", nameTouched: false };

export function SettingsView() {
  const { ready, user, logout, reload } = useConnections();
  const hydrated = useIsClient();
  const t = useTranslations("settings");
  const common = useTranslations("common");
  const errors = useTranslations("errors");
  const locale = useLocale();
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [gatewaysLoaded, setGatewaysLoaded] = useState(false);
  const [limits, setLimits] = useState<Limits>(EMPTY);
  const [saved, setSaved] = useState<Limits>(EMPTY);
  const [form, setForm] = useState<Draft>(BLANK);
  const [adding, setAdding] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [probe, setProbe] = useState<{ id: string; latencyMs: number; expiresAt: number } | null>(null);
  const [passwords, setPasswords] = useState({ current: "", next: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const admin = user?.role === "admin";

  async function load() {
    const limitRes = admin ? await fetch("/api/settings", { cache: "no-store" }) : null;
    const gatewayRes = await fetch("/api/gateways", { cache: "no-store" });
    if (gatewayRes.ok) setGateways((await gatewayRes.json()) as Gateway[]);
    setGatewaysLoaded(true);
    if (limitRes?.ok) {
      const body = (await limitRes.json()) as Limits;
      setLimits(body);
      setSaved(body);
    }
  }

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, admin]);

  const dirty = admin && JSON.stringify(limits) !== JSON.stringify(saved);
  const seller = form.kind === "newapi_seller";
  const supplier = form.kind === "newapi_supplier";
  const accountKind = seller || supplier;
  const alerts = user?.renewalAlerts ?? [];

  function openAdd(kind: Draft["kind"] = admin ? "newapi_admin" : "newapi_seller") {
    setForm({ ...BLANK, kind, name: kind === "newapi_seller" ? suggestSellerGatewayName("") : "" });
    setProbe(null);
    setShowPassword(false);
    setAdding(true);
    setError("");
  }

  function patch(next: Partial<Draft>, touchName = false) {
    setForm((current) => {
      const merged = { ...current, ...next, nameTouched: touchName ? true : current.nameTouched };
      if (merged.kind === "newapi_seller" && !merged.nameTouched && "baseUrl" in next) merged.name = suggestSellerGatewayName(merged.baseUrl);
      return merged;
    });
    setProbe(null);
  }

  async function testSeller() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/gateways/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: form.baseUrl, username: form.username, password: form.password }),
    });
    setBusy(false);
    const body = (await res.json().catch(() => null)) as { error?: { message?: string }; probeId?: string; latencyMs?: number; expiresAt?: number } | null;
    if (!res.ok || !body?.probeId) {
      setProbe(null);
      setError(body?.error?.message || errors("sellerAuthFailed"));
      return;
    }
    setProbe({ id: body.probeId, latencyMs: body.latencyMs ?? 0, expiresAt: body.expiresAt ?? 0 });
  }

  async function addGateway() {
    setBusy(true);
    setError("");
    const payload = seller
      ? { kind: "newapi_seller", name: form.name, baseUrl: form.baseUrl, username: form.username, password: form.password, probeId: probe?.id ?? "" }
      : supplier
        ? { kind: "newapi_supplier", name: form.name, baseUrl: form.baseUrl, username: form.username, password: form.password }
        : { name: form.name, baseUrl: form.baseUrl, adminUserId: form.adminUserId, token: form.token };
    const res = await fetch(form.id ? `/api/gateways/${form.id}` : "/api/gateways", {
      method: form.id ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) {
      setError(body?.error?.message || errors("gatewaySaveFailed"));
      return;
    }
    setForm(BLANK);
    setProbe(null);
    setAdding(false);
    setNotice(seller ? t("sellerSaved") : supplier ? t("supplierSaved") : t("savedGateway"));
    await load();
    await reload();
  }

  async function saveLimits() {
    setBusy(true);
    const res = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(limits) });
    setBusy(false);
    if (!res.ok) {
      setError(errors("settingsLoadFailed"));
      return;
    }
    const body = (await res.json()) as Limits;
    setLimits(body);
    setSaved(body);
    setNotice(t("limitsSaved"));
    await reload();
  }

  async function loadDemo() {
    setBusy(true);
    const res = await fetch("/api/gateways/demo", { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      setError(errors("demoLoadFailed"));
      return;
    }
    setNotice(t("demoReady"));
    await load();
  }

  async function toggleGateway(item: Gateway) {
    const res = await fetch(`/api/gateways/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled: !item.disabled }) });
    if (!res.ok) {
      setError(errors("gatewaySaveFailed"));
      return;
    }
    await load();
  }

  async function updatePassword() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/me/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: passwords.current, newPassword: passwords.next }) });
    setBusy(false);
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) {
      setError(body?.error?.message || errors("passwordInvalid"));
      return;
    }
    setNotice(t("passwordUpdated"));
    await logout();
  }

  if (!hydrated || !ready) return <p className="text-sm text-muted">{t("loading")}</p>;
  const knownError = (value: string) => ((errors as unknown as { has: (key: string) => boolean }).has(value) ? errors(value as "sellerAuthFailed") : value);
  const introKey = settingsIntroKey({ admin, kinds: gateways.map((item) => item.kind), draftingPassword: adding && accountKind });
  const toneClass = { muted: "bg-input text-muted", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", danger: "bg-danger-soft text-danger" };

  return (
    <div className="mx-auto max-w-[640px] pb-24">
      <PageHeader title={t("title")} description={!admin || gatewaysLoaded ? t(introKey) : undefined} />
      {alerts.map((item) => (
        <div key={item.id} className="mb-4 rounded-control bg-warn-soft px-4 py-3 text-sm leading-5 break-words text-warn">
          {t("renewalBanner", {
            name: item.name,
            when: formatShanghaiTime(item.checkedAt, locale),
            detail: item.detail ? knownError(item.detail) : "—",
            expires: formatShanghaiTime(item.expiresAt, locale),
          })}
        </div>
      ))}
      {error ? <div className="mb-4"><Alert tone="danger">{error}</Alert></div> : null}
      {notice ? <div className="mb-4"><Alert tone="info">{notice}</Alert></div> : null}
      <Card className="mb-4 p-5">
        <h2 className="text-sm font-medium">{t("account")}</h2>
        <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void updatePassword(); }}>
          <label className="block text-sm"><span className="mb-1.5 block text-secondary">{t("currentPassword")}</span>
            <input className={fieldClass} type="password" autoComplete="current-password" value={passwords.current} onChange={(event) => setPasswords({ ...passwords, current: event.target.value })} />
          </label>
          <label className="block text-sm"><span className="mb-1.5 block text-secondary">{t("newPassword")}</span>
            <input className={fieldClass} type="password" autoComplete="new-password" placeholder={t("passwordHint")} value={passwords.next} onChange={(event) => setPasswords({ ...passwords, next: event.target.value })} />
          </label>
          <button type="submit" className={buttonClass("primary")} disabled={busy}>{t("updatePassword")}</button>
        </form>
      </Card>
      {admin ? (
        <Card className="mb-4 p-5">
          <h2 className="text-sm font-medium">{t("site")}</h2>
          <label className="mt-4 block text-sm">
            <span className="mb-1.5 block text-secondary">{t("siteName")}</span>
            <input className={fieldClass} maxLength={40} value={limits.siteName} onChange={(event) => setLimits({ ...limits, siteName: event.target.value })} />
          </label>
        </Card>
      ) : null}
      <Card className="mb-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{t("gateways")}</h2>
          <button type="button" className={buttonClass("primary", "h-9")} onClick={() => openAdd()}>{t("addGateway")}</button>
        </div>
        <ul className="mt-3 space-y-2">
          {gateways.length === 0 ? <li className="text-sm text-muted">{t("noGateways")}</li> : gateways.map((item) => {
            const isSeller = item.kind === "newapi_seller";
            const failed = isSeller && item.authStatus === "failed";
            const copy = gatewayCardCopy(item);
            const credential = copy.subtitle === "account"
              ? t("accountLabel", { name: item.username || "—" })
              : copy.subtitle === "token"
                ? item.tokenMasked
                : copy.subtitle === "demo"
                  ? common("demo")
                  : copy.subtitle === "connected"
                    ? t("connected")
                    : copy.subtitle === "needRelogin"
                      ? t("needRelogin")
                      : t("tokenMissing");
            const pill = copy.pill === "deactivated" ? t("deactivated") : copy.pill === "connected" ? t("connected") : copy.pill === "needRelogin" ? t("needRelogin") : copy.pill === "connectionError" ? t("connectionError") : t("tokenInvalid");
            return (
              <li key={item.id} className="rounded-[14px] border border-line px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium break-words">{item.name}</span>
                      {isSeller ? <span className="whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-xs text-secondary">{t("kindSeller")}</span> : null}
                      {isSeller ? (
                        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${failed ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok"}`} title={failed ? `${formatShanghaiTime(item.authCheckedAt, locale)} ${knownError(item.authError || "")}` : undefined}>
                          {failed ? t("renewFailed") : t("renewOk")}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 break-all text-xs text-muted">{item.baseUrl}</div>
                    <div className="mt-1 break-words text-xs text-muted">
                      {credential}
                      {" · "}
                      {t("channelCount", { count: item.channelCount ?? 0 })}
                    </div>
                  </div>
                  <span title={copy.reloginTip ? t("supplierReloginTip") : undefined} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${toneClass[copy.tone]}`}>
                    {pill}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={buttonClass("ghost", "h-8 px-2")} onClick={() => void toggleGateway(item)}>{item.disabled ? t("enableGateway") : t("deactivate")}</button>
                  {isSeller ? (
                    <button type="button" className={buttonClass("ghost", "h-8 px-2")} onClick={() => { setForm({ ...BLANK, id: item.id, kind: "newapi_seller", name: item.name, baseUrl: item.baseUrl, username: item.username || "", nameTouched: true }); setProbe(null); setAdding(true); }}>{t("updateCredentials")}</button>
                  ) : null}
                  {admin && !isSeller ? <button type="button" className={buttonClass("ghost", "h-8 px-2")} disabled={busy} onClick={() => void loadDemo()}>{t("loadDemo")}</button> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      {admin ? (
        <>
          <Card className="mb-4 p-5">
            <h2 className="text-sm font-medium">{t("limits")}</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <label className="text-sm"><span className="mb-1.5 block text-secondary">{t("perGateway")}</span><input className={fieldClass} type="number" min={1} value={limits.gatewayPerMin} onChange={(event) => setLimits({ ...limits, gatewayPerMin: Number(event.target.value) })} /></label>
              <label className="text-sm"><span className="mb-1.5 block text-secondary">{t("perChannel")}</span><input className={fieldClass} type="number" min={1} value={limits.channelPerMin} onChange={(event) => setLimits({ ...limits, channelPerMin: Number(event.target.value) })} /></label>
              <label className="text-sm"><span className="mb-1.5 block text-secondary">{t("concurrency")}</span><input className={fieldClass} type="number" min={1} value={limits.concurrency} onChange={(event) => setLimits({ ...limits, concurrency: Number(event.target.value) })} /></label>
            </div>
          </Card>
          <Card className="mb-4 p-5">
            <h2 className="text-sm font-medium">{t("tolerance")}</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm"><span className="mb-1.5 block text-secondary">{t("dailyTolerance")}</span><input className={fieldClass} type="number" min={0} max={100} value={limits.reconTolerancePct} onChange={(event) => setLimits({ ...limits, reconTolerancePct: Number(event.target.value) })} /></label>
              <label className="text-sm"><span className="mb-1.5 block text-secondary">{t("supplierTolerance")}</span><input className={fieldClass} type="number" min={0} max={100} value={limits.manualTolerancePct} onChange={(event) => setLimits({ ...limits, manualTolerancePct: Number(event.target.value) })} /></label>
            </div>
          </Card>
        </>
      ) : null}
      <Card className="p-5">
        <h2 className="text-sm font-medium">{t("scheduleTitle")}</h2>
        <p className="mt-2 text-sm text-secondary">{t("scheduleBody")}</p>
      </Card>
      {adding ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-foreground/35">
          <form className="flex h-full w-full max-w-[440px] flex-col bg-card p-5" onSubmit={(event) => { event.preventDefault(); void addGateway(); }}>
            <h2 className="text-base font-semibold">{form.id ? t("updateCredentials") : t("addGateway")}</h2>
            {admin && !form.id ? (
              <div className="mt-4 inline-flex w-fit max-w-full flex-wrap rounded-full bg-input p-1" role="group">
                <button type="button" className={form.kind === "newapi_admin" ? "whitespace-nowrap rounded-full bg-card px-3 py-1 text-xs font-semibold" : "whitespace-nowrap rounded-full px-3 py-1 text-xs text-secondary"} onClick={() => patch({ kind: "newapi_admin", name: "" })}>{t("kindAdmin")}</button>
                <button type="button" className={seller ? "whitespace-nowrap rounded-full bg-card px-3 py-1 text-xs font-semibold" : "whitespace-nowrap rounded-full px-3 py-1 text-xs text-secondary"} onClick={() => patch({ kind: "newapi_seller", name: suggestSellerGatewayName(form.baseUrl) })}>{t("kindSeller")}</button>
                <button type="button" className={supplier ? "whitespace-nowrap rounded-full bg-card px-3 py-1 text-xs font-semibold" : "whitespace-nowrap rounded-full px-3 py-1 text-xs text-secondary"} onClick={() => patch({ kind: "newapi_supplier", name: form.baseUrl ? `jwt-${new URL(form.baseUrl.includes("://") ? form.baseUrl : `https://${form.baseUrl}`).hostname.replace(/[^a-z0-9]+/gi, "-")}` : "" })}>{t("kindSupplier")}</button>
              </div>
            ) : null}
            <div className="mt-4 space-y-3 overflow-y-auto">
              <label className="block text-sm">
                <span className="mb-1.5 block text-secondary">{t("name")}</span>
                <input className={fieldClass} value={form.name} onChange={(event) => patch({ name: event.target.value }, true)} />
                {accountKind ? <span className="mt-1 block text-xs leading-5 text-muted">{t("nameHint")}</span> : null}
              </label>
              <label className="block text-sm">
                <span className="mb-1.5 block text-secondary">{t("baseUrl")}</span>
                <input className={fieldClass} value={form.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} />
              </label>
              {accountKind ? (
                <>
                  <label className="block text-sm">
                    <span className="mb-1.5 block text-secondary">{t("sellerUsername")}</span>
                    <input className={fieldClass} autoComplete="off" value={form.username} onChange={(event) => patch({ username: event.target.value })} />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1.5 block text-secondary">{t("sellerPassword")}</span>
                    <span className="flex gap-2">
                      <input className={fieldClass} type={showPassword ? "text" : "password"} autoComplete="new-password" value={form.password} onChange={(event) => patch({ password: event.target.value })} />
                      <button type="button" className={buttonClass("secondary", "shrink-0")} onClick={() => setShowPassword((value) => !value)}>{showPassword ? t("hidePassword") : t("showPassword")}</button>
                    </span>
                  </label>
                  {seller ? (
                    <>
                      <button type="button" className={buttonClass("secondary")} disabled={busy || !form.baseUrl || !form.username || !form.password} onClick={() => void testSeller()}>{busy ? t("testing") : t("testConnection")}</button>
                      {probe ? <p className="text-sm text-ok">{t("loggedIn", { ms: probe.latencyMs })}</p> : <p className="text-xs leading-5 text-muted">{t("saveRequiresTest")}</p>}
                    </>
                  ) : (
                    <>
                      <p className="text-xs leading-5 text-muted">{t("supplierOriginNote")}</p>
                      <p className="rounded-control bg-warn-soft px-3 py-2 text-xs leading-5 text-warn">{t("supplierTlsNote")}</p>
                      <p className="text-xs leading-5 text-muted">{t("supplierSaveTests")}</p>
                    </>
                  )}
                  {probe ? (
                    <div className="rounded-control bg-ok-soft px-3 py-3 text-sm text-ok">
                      <span className="whitespace-nowrap rounded-full bg-card px-2 py-0.5 text-xs font-semibold">{t("renewOn")}</span>
                      <p className="mt-2 break-words text-xs leading-5">{t("renewDetail", { time: formatShanghaiTime(probe.expiresAt, locale) })}</p>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <input className={fieldClass} placeholder={t("adminUserId")} value={form.adminUserId} onChange={(event) => patch({ adminUserId: event.target.value })} />
                  <input className={fieldClass} placeholder={t("token")} type="password" value={form.token} onChange={(event) => patch({ token: event.target.value })} autoComplete="off" />
                  <p className="text-xs leading-5 text-muted">{t("tokenHint")}</p>
                </>
              )}
            </div>
            <div className="mt-auto flex flex-wrap justify-end gap-2 pt-4">
              <button type="button" className={buttonClass("secondary")} onClick={() => { setAdding(false); setProbe(null); }}>{common("cancel")}</button>
              <button type="submit" className={buttonClass("primary")} disabled={busy || (seller && !probe)}>{form.id ? t("updateCredentials") : t("addGateway")}</button>
            </div>
          </form>
        </div>
      ) : null}
      {dirty ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card px-4 py-3 md:left-sidebar">
          <div className="mx-auto flex max-w-[640px] flex-wrap items-center justify-between gap-3">
            <span className="text-sm">{t("dirty")}</span>
            <div className="flex gap-2">
              <button type="button" className={buttonClass("secondary")} onClick={() => setLimits(saved)}>{t("discard")}</button>
              <button type="button" className={buttonClass("primary")} disabled={busy} onClick={() => void saveLimits()}>{t("saveChanges")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
