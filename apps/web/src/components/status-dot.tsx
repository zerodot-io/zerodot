// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "@zerodot/ui";

const COLORS: Record<string, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-amber-500 animate-pulse motion-reduce:animate-none",
  waiting: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-muted-foreground/50",
  skipped: "bg-muted-foreground/30",
  idle: "bg-muted-foreground/30",
};

export function StatusDot({ status, className }: { status: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 rounded-full", COLORS[status] ?? COLORS.idle, className)}
    />
  );
}

export function StatusLabel({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot status={status} />
      <span className="capitalize">{status}</span>
    </span>
  );
}
