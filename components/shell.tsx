"use client";

import { LocaleToggle } from "@/components/locale-toggle";
import { BrandWord, LogoMark, VersionChip } from "@/components/logo-mark";
import { useConnections } from "@/components/providers";
import { buttonClass, cn, useIsClient } from "@/components/ui";
import { BRAND_NAME } from "@/lib/brand";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";

type IconName = "key" | "bill" | "recon" | "users" | "gear";
type Blob = "squircle" | "cloud" | "round";

const NAV: { href: string; labelKey: "channels" | "billing" | "recon" | "users" | "settings"; icon: IconName; color: string; blob: Blob; admin?: boolean }[] = [
  { href: "/channels", labelKey: "channels", icon: "key", color: "#007AFF", blob: "squircle" },
  { href: "/billing", labelKey: "billing", icon: "bill", color: "#FF9500", blob: "cloud" },
  { href: "/recon", labelKey: "recon", icon: "recon", color: "#30B0C7", blob: "squircle" },
  { href: "/admin/users", labelKey: "users", icon: "users", color: "#FF2D55", blob: "round", admin: true },
  { href: "/settings", labelKey: "settings", icon: "gear", color: "#A2845E", blob: "cloud" },
];

function NavIcon({ name }: { name: IconName }) {
  const common = "h-4 w-4 shrink-0";
  if (name === "key") {
    return (
      <svg viewBox="0 0 16 16" className={common} fill="none" aria-hidden>
        <circle cx="6" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8.5 8.5 13 13M11 11l1.5-1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "bill") {
    return (
      <svg viewBox="0 0 16 16" className={common} fill="none" aria-hidden>
        <path d="M4 2.5h8v11l-1.5-1-1.5 1L7.5 12.5 6 13.5 4.5 12.5 3 13.5v-11Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M6 6h4M6 8.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "recon") {
    return (
      <svg viewBox="0 0 16 16" className={common} fill="none" aria-hidden>
        <path d="M3 4.5h4.5M3 8h4.5M3 11.5h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="m9.5 9.5 1.4 1.4 2.6-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "gear") {
    return (
      <svg viewBox="0 0 16 16" className={common} fill="none" aria-hidden>
        <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className={common} fill="none" aria-hidden>
      <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="7" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 12.5c.6-1.6 2-2.5 3.5-2.5s2.9.9 3.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function NavBlob({ color, blob, children }: { color: string; blob: Blob; children: ReactNode }) {
  const shape = blob === "round" ? "rounded-full" : blob === "cloud" ? "rounded-[14px_10px_16px_12px]" : "rounded-[10px]";
  return (
    <span className={`relative flex h-7 w-7 shrink-0 items-center justify-center text-white ${shape}`} style={{ backgroundColor: color }}>
      {children}
      <span className="absolute left-1.5 top-1.5 h-1 w-1 rounded-full bg-white/80" />
      <span className="absolute right-1.5 top-2 h-1 w-1 rounded-full bg-white/80" />
    </span>
  );
}

function NavLinks({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { user } = useConnections();
  const t = useTranslations("nav");
  const items = NAV.filter((item) => !item.admin || user?.role === "admin");
  return (
    <nav className={cn("flex flex-col gap-1", collapsed ? "px-2" : "px-2.5")}>
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={t(item.labelKey)}
            onClick={onNavigate}
            className={cn(
              "flex items-center rounded-control text-sm transition",
              collapsed ? "justify-center px-0 py-2.5" : "px-2.5 py-2",
              active ? "bg-canvas font-medium text-foreground" : "text-secondary hover:bg-hover hover:text-foreground",
            )}
          >
            <span className={cn("flex min-w-0 items-center", collapsed ? "" : "gap-2.5")}>
              <NavBlob color={item.color} blob={item.blob}>
                <NavIcon name={item.icon} />
              </NavBlob>
              {collapsed ? <span className="sr-only">{t(item.labelKey)}</span> : <span>{t(item.labelKey)}</span>}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
      <path d={direction === "left" ? "M10 3.5 5.5 8 10 12.5" : "M6 3.5 10.5 8 6 12.5"} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useConnections();
  const hydrated = useIsClient();
  const t = useTranslations("shell");
  const common = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="min-h-screen bg-canvas text-foreground">
      {open ? <button className="fixed inset-0 z-30 bg-foreground/30 md:hidden" aria-label={common("closeMenu")} onClick={() => setOpen(false)} /> : null}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-card px-4 md:px-6">
        <button type="button" className={buttonClass("secondary", "h-10 px-2.5 md:hidden")} onClick={() => setOpen(true)} aria-label={common("openMenu")}>
          {common("menu")}
        </button>
        <Link href="/channels" className="flex min-w-0 items-center gap-2.5" title={user?.siteName || BRAND_NAME}>
          <LogoMark />
          <span className="brand-cjk truncate text-[15px] leading-[28px]">{user?.siteName || BRAND_NAME}</span>
        </Link>
        <span className="sr-only">{t("cacheNote")}</span>
        <div className="ml-auto flex items-center gap-3">
          <LocaleToggle />
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${user?.role === "admin" ? "bg-pink/15 text-pink" : "bg-ok-soft text-ok"}`}>
            {common(user?.role === "admin" ? "admin" : "supplier")}
          </span>
          <span className="max-w-32 truncate text-sm">{hydrated ? (user?.name ?? "") : ""}</span>
          <button type="button" className={buttonClass("ghost", "h-8 px-2")} onClick={() => void logout()}>{common("logout")}</button>
        </div>
      </header>
      <div className="flex min-h-[calc(100vh-3.5rem)]">
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-40 w-sidebar flex-col border-r border-line bg-sidebar transition-[width] duration-200 md:static md:flex",
            open ? "flex" : "hidden",
            collapsed ? "md:w-sidebar-collapsed" : "md:w-sidebar",
          )}
        >
          <div className={cn("flex items-center py-4", collapsed ? "flex-col gap-3 px-2" : "justify-between gap-2 px-3")} title={BRAND_NAME}>
            <Link href="/channels" title={BRAND_NAME} className={cn("flex min-w-0 items-center", collapsed ? "justify-center" : "gap-2.5")} onClick={() => setOpen(false)}>
              <LogoMark />
              {collapsed ? null : <BrandWord className="truncate text-[15px] leading-[28px]" />}
            </Link>
            <button type="button" className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-control text-secondary hover:bg-hover md:inline-flex" aria-label={collapsed ? common("expandSidebar") : common("collapseSidebar")} onClick={() => setCollapsed((value) => !value)}>
              <Chevron direction={collapsed ? "right" : "left"} />
            </button>
          </div>
          <Suspense fallback={<div className="px-3 py-2 text-sm text-muted">{common("openingMenu")}</div>}>
            <NavLinks collapsed={collapsed} onNavigate={() => setOpen(false)} />
          </Suspense>
          <div className={cn("mt-auto flex items-center gap-2 border-t border-line px-3 py-3", collapsed && "justify-center px-2")}>
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${user?.role === "admin" ? "bg-pink" : "bg-green"}`}>
              {(user?.name || user?.username || "?").slice(0, 1).toUpperCase()}
            </span>
            {collapsed ? null : (
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{hydrated ? (user?.name ?? "…") : "…"}</p>
                <span className={`mt-0.5 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${user?.role === "admin" ? "bg-pink/15 text-pink" : "bg-ok-soft text-ok"}`}>
                  {common(user?.role === "admin" ? "admin" : "supplier")}
                </span>
              </div>
            )}
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
      <VersionChip />
    </div>
  );
}
