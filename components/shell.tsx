"use client";

import { LocaleToggle } from "@/components/locale-toggle";
import { LogoMark, VersionChip } from "@/components/logo-mark";
import { useConnections } from "@/components/providers";
import { buttonClass, cn, useIsClient } from "@/components/ui";
import { BRAND_NAME } from "@/lib/brand";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";

type NavItem = { href: string; labelKey: "channels" | "billing" | "recon" | "users" | "settings"; color: string; admin?: boolean };

const NAV: NavItem[] = [
  { href: "/billing", labelKey: "billing", color: "#FF9500" },
  { href: "/channels", labelKey: "channels", color: "#007AFF" },
  { href: "/recon", labelKey: "recon", color: "#30B0C7" },
  { href: "/admin/users", labelKey: "users", color: "#FF2D55", admin: true },
  { href: "/settings", labelKey: "settings", color: "#A2845E" },
];

/** 统一的迷你 bot 脸：同 LogoMark 的眼睛样式，按导航项着色。 */
function NavBot({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 28 28" className="h-7 w-7 shrink-0" aria-hidden focusable="false">
      <rect width="28" height="28" rx="9" fill={color} />
      <ellipse cx="10.5" cy="14" rx="2.1" ry="3.4" fill="#fff" />
      <ellipse cx="17.5" cy="14" rx="2.1" ry="3.4" fill="#fff" />
    </svg>
  );
}

function NavLinks({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { user } = useConnections();
  const t = useTranslations("nav");
  const items = NAV.filter((item) => !item.admin || user?.role === "admin");
  return (
    <nav className={cn("flex flex-col gap-1 pt-3", collapsed ? "px-2" : "px-2.5")}>
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
              <NavBot color={item.color} />
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
        {/* 品牌固定在顶栏最左；侧栏不再重复 */}
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
          <div className={cn("flex items-center border-t border-line py-1.5", collapsed ? "justify-center px-2" : "justify-end px-3")}>
            <button type="button" className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-control text-secondary hover:bg-hover md:inline-flex" aria-label={collapsed ? common("expandSidebar") : common("collapseSidebar")} onClick={() => setCollapsed((value) => !value)}>
              <Chevron direction={collapsed ? "right" : "left"} />
            </button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
      <VersionChip />
    </div>
  );
}
