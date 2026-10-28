// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "@zerodot/ui";

export type BarPart = { value: number; tone: "ok" | "bad" | "neutral" };

export type Bar = {
  /** Read by screen readers and shown on hover. */
  text: string;
  parts: BarPart[];
};

const TONE: Record<BarPart["tone"], string> = {
  ok: "fill-emerald-500",
  bad: "fill-red-500",
  neutral: "fill-foreground/70",
};

/**
 * Stacked bars in one SVG. The bars stretch to the width of the box, so the SVG holds
 * no text. A marker is a dashed line at a bar, for example a publish.
 */
export function BarChart({
  bars,
  markers,
  maxLabel,
  startLabel,
  endLabel,
  summary,
  className,
}: {
  bars: Bar[];
  markers?: { index: number; text: string }[];
  maxLabel: string;
  startLabel: string;
  endLabel: string;
  summary: string;
  className?: string;
}) {
  const max = Math.max(1e-9, ...bars.map((b) => b.parts.reduce((sum, p) => sum + p.value, 0)));
  return (
    <figure className={cn("flex flex-col gap-1", className)}>
      <div className="text-right text-muted-foreground tabular-nums">{maxLabel}</div>
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${Math.max(1, bars.length)} 100`}
        preserveAspectRatio="none"
        className="h-48 w-full overflow-visible border-b"
      >
        {bars.map((bar, i) => {
          let y = 100;
          return (
            // The bar has no key but its place. Its place is its identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: bars never reorder
            <g key={i} className="[&:hover]:opacity-70">
              <title>{bar.text}</title>
              {/* A full-height hit area, so thin bars are easy to point at. */}
              <rect x={i} y={0} width={1} height={100} className="fill-transparent" />
              {bar.parts.map((part, p) => {
                const height = (part.value / max) * 100;
                y -= height;
                return (
                  <rect
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts have a fixed order
                    key={p}
                    x={i + 0.12}
                    y={y}
                    width={0.76}
                    height={height}
                    className={TONE[part.tone]}
                  />
                );
              })}
            </g>
          );
        })}
        {markers?.map((m) => (
          <line
            key={`${m.index}:${m.text}`}
            x1={m.index + 0.5}
            x2={m.index + 0.5}
            y1={0}
            y2={100}
            vectorEffect="non-scaling-stroke"
            strokeDasharray="3 3"
            className="stroke-foreground/40"
            strokeWidth={1}
          >
            <title>{m.text}</title>
          </line>
        ))}
      </svg>
      <div className="flex justify-between text-muted-foreground">
        <span>{startLabel}</span>
        <span>{endLabel}</span>
      </div>
    </figure>
  );
}

/** A small line of numbers. It has no axis. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? 100 / (values.length - 1) : 0;
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(20 - (v / max) * 18 - 1).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      className="h-5 w-20 text-muted-foreground"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}
