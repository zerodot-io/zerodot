// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils";

/** Orange dot, then one rounded dash in the current text color. Size it with the text size. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="80 129 240 143"
      aria-hidden="true"
      className={cn("h-[1em] w-auto shrink-0", className)}
    >
      <circle cx="151.25" cy="200.25" r="71.25" className="fill-primary" />
      <rect x="240.5" y="190.125" width="78.75" height="20.25" rx="10.125" fill="currentColor" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-medium tracking-tight", className)}>
      <LogoMark />
      zerodot
    </span>
  );
}
