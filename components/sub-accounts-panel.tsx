"use client";

import { useConnections } from "@/components/providers";
import { Alert, buttonClass, Card, ConfirmDialog, fieldClass, PageHeader, useIsClient } from "@/components/ui";
import { formatTimestamp } from "@/lib/format";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type SubRow = {
  id: string;
  username: string;
  disabled: boolean;
  lastLoginAt: number | null;
  createdAt: number;
  parentId: string;
};

export function SubAccountsPanel({ parentId, embedded = false, onChanged }: { parentId?: string; embedded?: boolean; onChanged?: () => void }) {
  const { ready, user } = useConnections();
  const hydrated = useIsClient();
  const router = useRouter();
  const t = useTranslations("subAccounts");
  const common = useTranslations("common");
  const errors = useTranslations("errors");
  const locale = useLocale();
  const [rows, setRows] = useState<SubRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({ username: "", password: "" });
  const [disableId, setDisableId] = useState("");
  const [resetId, setResetId] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [showReset, setShowReset] = useState(false);

  const load = useCallback(async () => {
    const query = parentId ? `?parent=${encodeURIComponent(parentId)}` : "";
    const res = await fetch(`/api/sub-accounts${query}`, { cache: "no-store" });
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message || errors("usersLoadFailed"));
      setLoading(false);
      return;
    }
    setRows((await res.json()) as SubRow[]);
    setError("");
    setLoading(false);
  }, [errors, parentId, router]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ready, load]);

  async function createAccount() {
    setBusy(true);
    setError("");
    setNotice("");
    const res = await fetch("/api/sub-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parentId ? { ...form, parentId } : form),
    });
    setBusy(false);
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: { message?: string }; username?: string } | null;
    if (!res.ok || !body?.username) {
      setError(body?.error?.message || errors("userCreateFailed"));
      return;
    }
    const username = body.username;
    setForm({ username: "", password: "" });
    setShowPassword(false);
    setCreating(false);
    setNotice(t("created", { username }));
    await load();
    onChanged?.();
  }

  async function setDisabled(id: string, disabled: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    const res = await fetch(`/api/sub-accounts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    setBusy(false);
    setDisableId("");
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message || errors("userUpdateFailed"));
      return;
    }
    await load();
    onChanged?.();
  }

  async function resetPassword() {
    setBusy(true);
    setError("");
    setNotice("");
    const res = await fetch(`/api/sub-accounts/${resetId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: nextPassword }),
    });
    setBusy(false);
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message || errors("passwordResetFailed"));
      return;
    }
    setResetId("");
    setNextPassword("");
    setShowReset(false);
    setNotice(t("resetDone"));
    await load();
    onChanged?.();
  }

  if (!hydrated || !ready) return <p className="text-sm text-muted">{t("loading")}</p>;
  const parentSupplier = user?.role === "supplier" && !user.parentUserId;
  const allowed = parentSupplier || (user?.role === "admin" && Boolean(parentId));
  if (!allowed) return <Alert tone="danger">{t("parentOnly")}</Alert>;

  const columns = [t("columns.username"), t("columns.status"), t("columns.lastLogin"), t("columns.actions")];
  const resetRow = rows.find((row) => row.id === resetId);

  const table = loading ? (
    <p className="px-4 py-10 text-center text-sm text-muted">{t("loading")}</p>
  ) : rows.length === 0 ? (
    <p className="px-4 py-10 text-center text-sm text-muted">{t("empty")}</p>
  ) : (
    <div className="overflow-x-auto">
      <table className="w-max min-w-full text-left text-sm">
        <thead className="bg-input text-xs text-secondary">
          <tr>
            {columns.map((label) => (
              <th key={label} className="whitespace-nowrap px-4 py-3 font-medium">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.id} className={row.disabled ? "opacity-[0.55]" : undefined}>
              <td className="whitespace-nowrap px-4 py-3 font-medium">{row.username}</td>
              <td className="whitespace-nowrap px-4 py-3">
                <span className={row.disabled ? "inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-2.5 py-0.5 text-xs font-medium text-danger" : "inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-medium text-ok"}>
                  <span className={row.disabled ? "h-1.5 w-1.5 rounded-full bg-danger" : "h-1.5 w-1.5 rounded-full bg-ok"} />
                  {row.disabled ? t("disabled") : t("enabled")}
                </span>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{formatTimestamp(row.lastLoginAt, locale)}</td>
              <td className="whitespace-nowrap px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {row.disabled ? (
                    <button type="button" className={buttonClass("secondary", "h-8")} disabled={busy} onClick={() => void setDisabled(row.id, false)}>
                      {t("enable")}
                    </button>
                  ) : (
                    <button type="button" className={buttonClass("danger", "h-8")} disabled={busy} onClick={() => setDisableId(row.id)}>
                      {t("disable")}
                    </button>
                  )}
                  <button type="button" className={buttonClass("secondary", "h-8")} disabled={busy} onClick={() => { setResetId(row.id); setNextPassword(""); setShowReset(false); }}>
                    {t("reset")}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      {embedded ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm leading-6 text-secondary">{t("hint")}</p>
          <button type="button" className={buttonClass("primary", "h-9")} onClick={() => { setCreating(true); setError(""); }}>{t("create")}</button>
        </div>
      ) : (
        <PageHeader
          title={t("title")}
          description={t("description")}
          extra={<button type="button" className={buttonClass("primary")} onClick={() => { setCreating(true); setError(""); }}>{t("create")}</button>}
        />
      )}
      {error ? <div className="mb-4"><Alert tone="danger">{error}</Alert></div> : null}
      {notice ? <div className="mb-4"><Alert tone="info">{notice}</Alert></div> : null}
      <Card>{table}</Card>
      {creating ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-foreground/35">
          <form className="flex h-full w-full max-w-[440px] flex-col bg-card p-5" onSubmit={(event) => { event.preventDefault(); void createAccount(); }}>
            <h2 className="text-base font-semibold">{t("create")}</h2>
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="mb-1.5 block text-secondary">{t("username")} *</span>
                <input className={fieldClass} autoComplete="off" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
              </label>
              <label className="block text-sm">
                <span className="mb-1.5 block text-secondary">{t("password")} *</span>
                <span className="flex gap-2">
                  <input className={fieldClass} type={showPassword ? "text" : "password"} autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
                  <button type="button" className={buttonClass("secondary", "shrink-0")} onClick={() => setShowPassword((value) => !value)}>{showPassword ? t("hidePassword") : t("showPassword")}</button>
                </span>
              </label>
              <p className="text-xs leading-5 text-muted">{t("hint")}</p>
            </div>
            <div className="mt-auto flex flex-wrap justify-end gap-2 pt-4">
              <button type="button" className={buttonClass("secondary")} onClick={() => { setCreating(false); setShowPassword(false); }}>{common("cancel")}</button>
              <button type="submit" className={buttonClass("primary")} disabled={busy}>{t("create")}</button>
            </div>
          </form>
        </div>
      ) : null}
      {disableId ? (
        <ConfirmDialog
          title={t("disableTitle")}
          body={t("disableBody")}
          confirmLabel={t("disable")}
          busy={busy}
          onClose={() => setDisableId("")}
          onConfirm={() => void setDisabled(disableId, true)}
        />
      ) : null}
      {resetId ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-4 sm:items-center">
          <form
            className="w-full max-w-md rounded-card border border-line bg-card p-5 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              void resetPassword();
            }}
          >
            <h2 className="text-base font-semibold">{t("resetTitle")}</h2>
            <p className="mt-2 text-sm leading-6 text-secondary">{t("resetBody", { username: resetRow?.username ?? "" })}</p>
            <label className="mt-4 block text-sm">
              <span className="mb-1.5 block text-secondary">{t("password")}</span>
              <span className="flex gap-2">
                <input className={fieldClass} type={showReset ? "text" : "password"} autoComplete="new-password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} />
                <button type="button" className={buttonClass("secondary", "shrink-0")} onClick={() => setShowReset((value) => !value)}>{showReset ? t("hidePassword") : t("showPassword")}</button>
              </span>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className={buttonClass("secondary")} disabled={busy} onClick={() => { setResetId(""); setNextPassword(""); }}>{common("cancel")}</button>
              <button type="submit" className={buttonClass("primary")} disabled={busy}>{t("reset")}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
