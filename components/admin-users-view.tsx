"use client";

import { useConnections } from "@/components/providers";
import { Alert, Avatar, buttonClass, Card, fieldClass, PageHeader, useIsClient } from "@/components/ui";
import { formatTimestamp } from "@/lib/format";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type UserRow = {
  id: string;
  username: string;
  name: string;
  role: "admin" | "supplier";
  disabled: boolean;
  createdAt: number;
  channelCount: number;
};

const EMPTY = { username: "", name: "", password: "" };

export function AdminUsersView() {
  const { ready, user } = useConnections();
  const hydrated = useIsClient();
  const router = useRouter();
  const t = useTranslations("users");
  const common = useTranslations("common");
  const errors = useTranslations("errors");
  const locale = useLocale();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [resetId, setResetId] = useState("");
  const [nextPassword, setNextPassword] = useState("");

  async function load() {
    const res = await fetch("/api/admin/users", { cache: "no-store" });
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (!res.ok) {
      setError(errors("usersLoadFailed"));
      setLoading(false);
      return;
    }
    setRows((await res.json()) as UserRow[]);
    setError("");
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/users", { cache: "no-store" }).then(async (res) => {
      if (cancelled) return;
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) {
        setError(errors("usersLoadFailed"));
        setLoading(false);
        return;
      }
      setRows((await res.json()) as UserRow[]);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [router, errors]);

  async function createUser() {
    setCreating(true);
    setError("");
    setNotice("");
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    setCreating(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message || errors("supplierCreateFailed"));
      return;
    }
    setForm(EMPTY);
    setNotice(t("created"));
    await load();
  }

  async function toggle(row: UserRow) {
    setBusyId(row.id);
    setError("");
    setNotice("");
    const res = await fetch(`/api/admin/users/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: !row.disabled }),
    });
    setBusyId("");
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message || errors("userUpdateFailed"));
      return;
    }
    await load();
  }

  async function savePassword(row: UserRow) {
    setBusyId(row.id);
    setError("");
    setNotice("");
    const res = await fetch(`/api/admin/users/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: nextPassword }),
    });
    setBusyId("");
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
    setNotice(row.id === user?.id ? t("resetSelf") : t("resetOther", { username: row.username }));
    if (row.id === user?.id) {
      router.replace("/login");
      return;
    }
  }

  async function logoutDevices(row: UserRow) {
    setBusyId(row.id);
    setError("");
    setNotice("");
    const res = await fetch(`/api/admin/users/${row.id}/sessions`, { method: "POST" });
    setBusyId("");
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message || errors("userUpdateFailed"));
      return;
    }
    setNotice(t("loggedOutAll", { username: row.username }));
    if (row.id === user?.id) router.replace("/login");
  }

  if (!hydrated || !ready) return <p className="text-sm text-muted">{t("loading")}</p>;
  if (user?.role !== "admin") return <Alert tone="danger">{t("adminOnly")}</Alert>;
  const columns = [t("columns.username"), t("columns.name"), t("columns.role"), t("columns.channels"), t("columns.status"), t("columns.created"), t("columns.actions")];

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      {error ? (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4">
          <Alert tone="info">{notice}</Alert>
        </div>
      ) : null}
      <Card className="mb-4 p-4 md:p-5">
        <h2 className="text-sm font-semibold text-foreground">{t("createTitle")}</h2>
        <p className="mt-1 text-sm text-secondary">{t("createHint")}</p>
        <form
          className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void createUser();
          }}
        >
          <label className="block text-sm">
            <span className="mb-1.5 block text-secondary">{t("username")}</span>
            <input className={fieldClass} value={form.username} autoComplete="off" placeholder="huadong" onChange={(event) => setForm({ ...form, username: event.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block text-secondary">{t("displayName")}</span>
            <input className={fieldClass} value={form.name} maxLength={40} placeholder={t("namePlaceholder")} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block text-secondary">{t("password")}</span>
            <input className={fieldClass} type="password" autoComplete="new-password" value={form.password} placeholder={t("passwordPlaceholder")} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </label>
          <button type="submit" className={buttonClass("primary")} disabled={creating}>
            {creating ? t("creating") : t("create")}
          </button>
        </form>
      </Card>
      <Card>
        {loading ? (
          <p className="px-4 py-10 text-center text-sm text-muted">{t("loadingList")}</p>
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
                  <tr key={row.id}>
                    <td className="whitespace-nowrap px-4 py-3 font-medium">
                      <span className="inline-flex items-center gap-2">
                        <Avatar name={row.name || row.username} seed={row.username} size="sm" />
                        {row.username}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-secondary">{row.name}</td>
                    <td className="whitespace-nowrap px-4 py-3">{row.role === "admin" ? common("admin") : common("supplier")}</td>
                    <td className="whitespace-nowrap px-4 py-3">{row.channelCount}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className={row.disabled ? "inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-2.5 py-0.5 text-xs font-medium text-danger" : "inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-medium text-ok"}>
                        <span className={row.disabled ? "h-1.5 w-1.5 rounded-full bg-danger" : "h-1.5 w-1.5 rounded-full bg-ok"} />
                        {row.disabled ? t("disabled") : t("active")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{formatTimestamp(row.createdAt, locale)}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {row.id === user.id ? (
                          <span className="text-xs text-muted">{t("current")}</span>
                        ) : (
                          <button type="button" className={buttonClass(row.disabled ? "secondary" : "danger", "h-8")} disabled={busyId === row.id} onClick={() => void toggle(row)}>
                            {busyId === row.id ? common("working") : row.disabled ? t("enable") : t("disable")}
                          </button>
                        )}
                        {resetId === row.id ? (
                          <form
                            className="flex flex-wrap items-center gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void savePassword(row);
                            }}
                          >
                            <input className={`${fieldClass} h-8 w-36`} type="password" autoComplete="new-password" value={nextPassword} placeholder={t("newPassword")} onChange={(event) => setNextPassword(event.target.value)} />
                            <button type="submit" className={buttonClass("primary", "h-8")} disabled={busyId === row.id}>
                              {common("confirm")}
                            </button>
                            <button type="button" className={buttonClass("ghost", "h-8 px-2")} onClick={() => { setResetId(""); setNextPassword(""); }}>
                              {common("cancel")}
                            </button>
                          </form>
                        ) : (
                          <button type="button" className={buttonClass("secondary", "h-8")} onClick={() => { setResetId(row.id); setNextPassword(""); }}>
                            {t("reset")}
                          </button>
                        )}
                        <button type="button" className={buttonClass("secondary", "h-8")} disabled={busyId === row.id} onClick={() => void logoutDevices(row)}>
                          {t("logoutAll")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
