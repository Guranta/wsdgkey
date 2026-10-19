import { VersionChip } from "@/components/logo-mark";
import { LocaleToggle } from "@/components/locale-toggle";

function Deco({ className }: { className: string }) {
  return (
    <span className={`absolute grid place-items-center ${className}`}>
      <span className="flex gap-[5px]">
        <span className="h-2.5 w-[4px] rounded-[2px] bg-white" />
        <span className="h-2.5 w-[4px] rounded-[2px] bg-white" />
      </span>
    </span>
  );
}

export function AuthScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <Deco className="left-[18%] top-[18%] h-11 w-11 rounded-full bg-green" />
        <Deco className="right-[20%] top-[22%] h-9 w-9 rounded-[12px] bg-pink" />
        <Deco className="bottom-[24%] left-[22%] h-10 w-10 rounded-[40%_40%_35%_35%/50%_50%_40%_40%] bg-teal" />
        <Deco className="bottom-[20%] right-[18%] h-8 w-8 rounded-full bg-orange" />
      </div>
      <div className="absolute right-4 top-4 z-10">
        <LocaleToggle />
      </div>
      <div className="relative z-[1] w-full max-w-[400px]">{children}</div>
      <VersionChip />
    </div>
  );
}
