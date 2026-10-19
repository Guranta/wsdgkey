"use client";

import { useConnections } from "@/components/providers";
import { BRAND_NAME } from "@/lib/brand";
import { Alert, buttonClass, Card, fieldClass, PageHeader, useIsClient } from "@/components/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type Gateway = { id: string; name: string; baseUrl: string; adminUserId: string; demo: boolean; tokenSet: boolean; tokenMasked?: string; disabled?: boolean; channelCount?: number; lastSyncAt?: number | null };
type Limits = { siteName: string; gatewayPerMin: number; channelPerMin: number; concurrency: number; testCooldownMin: number; quotaPerUnit: number; reconTolerancePct: number; zeroDays: number; manualTolerancePct: number };

const EMPTY: Limits = { siteName: BRAND_NAME, gatewayPerMin: 60, channelPerMin: 5, concurrency: 3, testCooldownMin: 10, quotaPerUnit: 500000, reconTolerancePct: 1, zeroDays: 3, manualTolerancePct: 2 };

export function SettingsView() {
  const { ready, user, logout, reload } = useConnections();
  const hydrated = useIsClient();
  const t = useTranslations("settings");
  const common = useTranslations("common");
  const errors = useTranslations("errors");
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [limits, setLimits] = useState<Limits>(EMPTY);
  const [saved, setSaved] = useState<Limits>(EMPTY);
  const [form, setForm] = useState({ name: "", baseUrl: "", adminUserId: "1", token: "" });
  const [adding, setAdding] = useState(false);
  const [passwords, setPasswords] = useState({ current: "", next: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const admin = user?.role === "admin";

  async function load() {
    const limitRes = admin ? await fetch("/api/settings", { cache: "no-store" }) : null;
    const gatewayRes = admin ? await fetch("/api/gateways", { cache: "no-store" }) : null;
    if (gatewayRes?.ok) setGateways((await gatewayRes.json()) as Gateway[]);
    if (limitRes?.ok) {
      const body = (await limitRes.json()) as Limits;
      setLimits(body);
      setSaved(body);
    }
  }

  useEffect(() => {
    if (!ready || !admin) return;
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
    // load closes over the latest admin flag; the effect re-runs when that flag changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, admin]);

  const dirty = admin && JSON.stringify(limits) !== JSON.stringify(saved);

  async function addGateway() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/gateways", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    setBusy(false);
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) {
      setError(body?.error?.message || errors("gatewaySaveFailed"));
      return;
    }
    setForm({ name: "", baseUrl: "", adminUserId: "1", token: "" });
    setAdding(false);
    setNotice(t("savedGateway"));
    await load();
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

  return (
    <div className="mx-auto max-w-[640px] pb-24">
      <PageHeader title={t("title")} description={admin ? t("description") : t("supplierHint")} />
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
        <>
          <Card className="mb-4 p-5">
            <h2 className="text-sm font-medium">{t("site")}</h2>
            <label className="mt-4 block text-sm">
              <span className="mb-1.5 block text-secondary">{t("siteName")}</span>
              <input className={fieldClass} maxLength={40} value={limits.siteName} onChange={(event) => setLimits({ ...limits, siteName: event.target.value })} />
            </label>
          </Card>
          <Card className="mb-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">{t("gateways")}</h2>
              <button type="button" className={buttonClass("primary", "h-9")} onClick={() => setAdding(true)}>{t("addGateway")}</button>
            </div>
            <ul className="mt-3 space-y-2">
              {gateways.length === 0 ? <li className="text-sm text-muted">{t("noGateways")}</li> : gateways.map((item) => (
                <li key={item.id} className="rounded-[14px] border border-line px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">{item.name}</div>
                      <div className="mt-1 text-xs text-muted">{item.baseUrl}</div>
                      <div className="mt-1 text-xs text-muted">{item.tokenMasked || (item.demo ? common("demo") : t("tokenMissing"))} · {t("channelCount", { count: item.channelCount ?? 0 })}</div>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${item.disabled ? "bg-input text-muted" : item.tokenSet || item.demo ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger"}`}>
                      {item.disabled ? t("deactivated") : item.tokenSet || item.demo ? t("connected") : t("tokenInvalid")}
                    </span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button type="button" className={buttonClass("ghost", "h-8 px-2")} onClick={() => void toggleGateway(item)}>{item.disabled ? t("enableGateway") : t("deactivate")}</button>
                    <button type="button" className={buttonClass("ghost", "h-8 px-2")} disabled={busy} onClick={() => void loadDemo()}>{t("loadDemo")}</button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
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
            <h2 className="text-base font-semibold">{t("addGateway")}</h2>
            <div className="mt-4 space-y-3">
              <input className={fieldClass} placeholder={t("name")} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              <input className={fieldClass} placeholder={t("baseUrl")} value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
              <input className={fieldClass} placeholder={t("adminUserId")} value={form.adminUserId} onChange={(event) => setForm({ ...form, adminUserId: event.target.value })} />
              <input className={fieldClass} placeholder={t("token")} type="password" value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} autoComplete="off" />
              <p className="text-xs leading-5 text-muted">{t("tokenHint")}</p>
            </div>
            <div className="mt-auto flex justify-end gap-2">
              <button type="button" className={buttonClass("secondary")} onClick={() => setAdding(false)}>{common("cancel")}</button>
              <button type="submit" className={buttonClass("primary")} disabled={busy}>{t("addGateway")}</button>
            </div>
          </form>
        </div>
      ) : null}
      {dirty ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card px-4 py-3 md:left-sidebar">
          <div className="mx-auto flex max-w-[640px] items-center justify-between gap-3">
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
