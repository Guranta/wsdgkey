import { APP_TITLE, BRAND_NAME } from "@/lib/brand";

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="km-mark shrink-0" width={size} height={size} viewBox="0 0 64 64" aria-hidden focusable="false">
      <path fill="#0A0A0A" d="M33 5C49 5 59.5 15.5 59.5 31.5C59.5 48 48.5 59.5 31.5 59.5C15.5 59.5 4.5 49 4.5 32.5C4.5 15.5 17 5 33 5Z" />
      {size >= 16 ? <ellipse fill="#30B0C7" cx="46.5" cy="15.5" rx="4.2" ry="2.4" transform="rotate(35 46.5 15.5)" /> : null}
      <g className="km-eyes" fill="#fff">
        <ellipse cx="24.5" cy="32" rx="5" ry="8.2" />
        <ellipse cx="40.5" cy="32" rx="5" ry="8.2" />
      </g>
    </svg>
  );
}

export function VersionChip() {
  return <p className="pointer-events-none fixed bottom-4 right-4 z-30 rounded-full bg-foreground/85 px-3 py-1 text-xs text-white">{APP_TITLE}</p>;
}

export function BrandWord({ className = "" }: { className?: string }) {
  return <span className={`brand-cjk ${className}`}>{BRAND_NAME}</span>;
}
