// SPDX-License-Identifier: AGPL-3.0-only

import { Fragment, type ReactNode } from "react";

/** Props that give a chart a dark panel with a dashed crosshair. */
export const FEED_TOOLTIP = {
  showDatePill: false,
  showCrosshair: true,
  showDots: false,
  indicatorDasharray: "5 8",
  indicatorFadeEdges: "none",
  backgroundColor: "var(--foreground)",
} as const;

export interface TooltipPanelRow {
  key: string;
  label: ReactNode;
  value: string;
  /** Dot before the label. */
  color?: string | undefined;
}

/** The body of a chart tooltip: a title, then a label and a value on each row. */
export function TooltipPanel({
  title,
  rows,
  total,
}: {
  title: ReactNode;
  rows: readonly TooltipPanelRow[];
  /** A last row, for charts that stack more than one series. */
  total?: { label: ReactNode; value: string } | undefined;
}) {
  return (
    <div className="flex min-w-56 max-w-72 flex-col gap-2 p-3 text-background tabular-nums">
      <div className="border-background/10 border-b pb-2 font-medium">{title}</div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
        {rows.map((row) => (
          <Fragment key={row.key}>
            <span className="flex min-w-0 items-center gap-2">
              {row.color && (
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: row.color }}
                />
              )}
              <span className="truncate">{row.label}</span>
            </span>
            <span className="text-right font-semibold">{row.value}</span>
          </Fragment>
        ))}
        {total && (
          <>
            <span className="col-span-2 my-1 h-px bg-background/10" />
            <span className="text-background/80">{total.label}</span>
            <span className="text-right font-semibold">{total.value}</span>
          </>
        )}
      </div>
    </div>
  );
}
