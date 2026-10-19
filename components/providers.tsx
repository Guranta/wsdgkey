"use client";

import type { SessionUser } from "@/lib/types";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

type SessionValue = {
  ready: boolean;
  user: SessionUser | null;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch("/api/me", { cache: "no-store" });
    if (!res.ok) {
      setUser(null);
      setReady(true);
      return;
    }
    setUser((await res.json()) as SessionUser);
    setReady(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/me", { cache: "no-store" });
      if (cancelled) return;
      setUser(res.ok ? ((await res.json()) as SessionUser) : null);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    router.replace("/login");
    router.refresh();
  }, [router]);

  return <SessionContext.Provider value={{ ready, user, logout, reload }}>{children}</SessionContext.Provider>;
}

export function useConnections(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("sessionNotReady");
  return value;
}
