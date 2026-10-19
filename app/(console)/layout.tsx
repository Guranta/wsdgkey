import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell";
import { Suspense } from "react";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <Suspense fallback={<div className="p-8 text-sm text-secondary">正在打开控制台…</div>}>
        <Shell>{children}</Shell>
      </Suspense>
    </Providers>
  );
}
