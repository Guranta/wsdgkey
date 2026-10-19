"use client";

import type { ConnectionStatus } from "@/lib/types";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useSyncExternalStore } from "react";

export function useIsClient(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const BUTTON = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
  secondary: "bg-primary-soft text-foreground hover:bg-hover",
  ghost: "text-secondary hover:bg-hover",
  danger: "border border-danger/20 bg-card text-danger hover:bg-danger-soft",
} as const;

export function buttonClass(variant: keyof typeof BUTTON = "primary", className?: string): string {
  return cn(
    "inline-flex h-10 w-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-[15px] font-semibold leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 disabled:cursor-not-allowed disabled:opacity-50",
    variant === "primary" ? "h-11 px-5" : "px-3.5",
    BUTTON[variant],
    className,
  );
}

export const controlClass =
  "w-full rounded-control border border-line bg-input px-3 text-sm text-foreground outline-none transition placeholder:text-muted focus:border-blue focus:ring-2 focus:ring-blue/25";

export const fieldClass = cn("h-10", controlClass);

export function PageHeader({
  title,
  description,
  extra,
}: {
  title: string;
  description?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[26px] font-bold leading-[1.25] text-foreground">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm leading-6 text-secondary">{description}</p> : null}
      </div>
      {extra}
    </div>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-card border border-line bg-card shadow-sm", className)}>{children}</section>;
}

const STATUS_CLASS: Record<ConnectionStatus, string> = {
  unknown: "bg-input text-muted",
  ok: "bg-ok-soft text-ok",
  expiring: "bg-warn-soft text-warn",
  failing: "bg-danger-soft text-danger",
  expired: "bg-danger-soft text-danger",
};

const STATUS_DOT: Record<ConnectionStatus, string> = {
  unknown: "bg-muted",
  ok: "bg-ok",
  expiring: "bg-warn",
  failing: "bg-danger",
  expired: "bg-danger",
};

export function StatusBadge({ status }: { status: ConnectionStatus }) {
  const t = useTranslations("common");
  const label = status === "ok" ? t("enabled") : status === "unknown" ? t("dash") : t("disabled");
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", STATUS_CLASS[status])}>
      <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status])} />
      {label}
    </span>
  );
}

const ACCENT_BG = ["bg-green", "bg-pink", "bg-brown", "bg-red", "bg-cyan", "bg-orange", "bg-blue", "bg-purple"] as const;

export function accentIndex(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return hash % ACCENT_BG.length;
}

export function Avatar({ name, seed, size = "md" }: { name: string; seed?: string; size?: "sm" | "md" }) {
  const letter = name.trim().slice(0, 1) || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-accent-foreground",
        ACCENT_BG[accentIndex(seed || name || letter)],
        size === "sm" ? "h-6 w-6 text-[11px]" : "h-8 w-8 text-sm",
      )}
    >
      {letter}
    </span>
  );
}

export function EmptyConnection({ title, body }: { title: string; body: string }) {
  const t = useTranslations("system");
  return (
    <Card className="px-6 py-16 text-center">
      <h2 className="text-base font-medium text-foreground">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-secondary">{body}</p>
      <Link href="/channels" className={cn(buttonClass("primary"), "mt-5")}>
        {t("goChannels")}
      </Link>
    </Card>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("common");
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-card border border-line bg-card p-5 shadow-sm">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-secondary">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={buttonClass("secondary")} onClick={onClose} disabled={busy}>
            {t("cancel")}
          </button>
          <button type="button" className={buttonClass("primary")} onClick={onConfirm} disabled={busy}>
            {busy ? t("working") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Alert({ tone, children }: { tone: "info" | "warn" | "danger"; children: React.ReactNode }) {
  const toneClass = {
    info: "border-line bg-primary-soft text-foreground",
    warn: "border-warn/20 bg-warn-soft text-warn",
    danger: "border-danger/20 bg-danger-soft text-danger",
  }[tone];
  return (
    <div role="status" className={cn("rounded-control border px-3 py-2 text-sm leading-6", toneClass)}>
      {children}
    </div>
  );
}
