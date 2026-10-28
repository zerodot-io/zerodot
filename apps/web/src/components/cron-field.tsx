// SPDX-License-Identifier: AGPL-3.0-only

import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@zerodot/ui";
import { CronExpressionParser } from "cron-parser";

type Kind =
  | "minute"
  | "5min"
  | "15min"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

const KINDS: { value: Kind; label: string }[] = [
  { value: "minute", label: "Every minute" },
  { value: "5min", label: "Every 5 minutes" },
  { value: "15min", label: "Every 15 minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom cron" },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Parts = { kind: Kind; minute: number; hour: number; day: number };

const num = "(\\d{1,2})";

function parse(expression: string): Parts {
  const base: Parts = { kind: "custom", minute: 0, hour: 9, day: 1 };
  const e = expression.trim().replace(/\s+/g, " ");
  if (e === "* * * * *") return { ...base, kind: "minute" };
  if (e === "*/5 * * * *") return { ...base, kind: "5min" };
  if (e === "*/15 * * * *") return { ...base, kind: "15min" };
  let m = new RegExp(`^${num} \\* \\* \\* \\*$`).exec(e);
  if (m) return { ...base, kind: "hourly", minute: Number(m[1]) };
  m = new RegExp(`^${num} ${num} \\* \\* \\*$`).exec(e);
  if (m) return { ...base, kind: "daily", minute: Number(m[1]), hour: Number(m[2]) };
  m = new RegExp(`^${num} ${num} \\* \\* 1-5$`).exec(e);
  if (m) return { ...base, kind: "weekdays", minute: Number(m[1]), hour: Number(m[2]) };
  m = new RegExp(`^${num} ${num} \\* \\* ([0-6])$`).exec(e);
  if (m) {
    return { kind: "weekly", minute: Number(m[1]), hour: Number(m[2]), day: Number(m[3]) };
  }
  m = new RegExp(`^${num} ${num} ${num} \\* \\*$`).exec(e);
  if (m) {
    return { kind: "monthly", minute: Number(m[1]), hour: Number(m[2]), day: Number(m[3]) };
  }
  return base;
}

function build({ kind, minute, hour, day }: Parts): string {
  switch (kind) {
    case "minute":
      return "* * * * *";
    case "5min":
      return "*/5 * * * *";
    case "15min":
      return "*/15 * * * *";
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${day}`;
    case "monthly":
      return `${minute} ${hour} ${day} * *`;
    case "custom":
      return "";
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

function nextRuns(expression: string, timezone: string): { dates: Date[]; error?: string } {
  try {
    const it = CronExpressionParser.parse(expression, { tz: timezone || "UTC" });
    return { dates: it.take(3).map((d) => d.toDate()) };
  } catch (error) {
    return { dates: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function CronField({
  id,
  value,
  timezone,
  onChange,
}: {
  id: string;
  value: string;
  timezone: string;
  onChange: (next: string) => void;
}) {
  const parts = parse(value);
  const kind = parts.kind;
  const update = (patch: Partial<Parts>) => {
    const next = { ...parts, ...patch };
    if (next.kind === "custom") return;
    onChange(build(next));
  };
  const hasTime =
    kind === "daily" || kind === "weekdays" || kind === "weekly" || kind === "monthly";
  const { dates, error } = value.trim() ? nextRuns(value, timezone) : { dates: [] };
  const format = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone || "UTC",
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          items={KINDS}
          value={kind}
          onValueChange={(next) => {
            const k = next as Kind;
            // Custom keeps the text so the user can edit it.
            if (k !== "custom") update({ kind: k });
            else if (!value) onChange("0 * * * *");
            else onChange(value);
          }}
        >
          <SelectTrigger id={id} className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {kind === "weekly" && (
          <Select
            items={DAYS.map((d, i) => ({ value: String(i), label: d }))}
            value={String(parts.day)}
            onValueChange={(d) => update({ day: Number(d) })}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAYS.map((d, i) => (
                <SelectItem key={d} value={String(i)}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {kind === "monthly" && (
          <Select
            items={Array.from({ length: 28 }, (_, i) => ({
              value: String(i + 1),
              label: `Day ${i + 1}`,
            }))}
            value={String(parts.day)}
            onValueChange={(d) => update({ day: Number(d) })}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                <SelectItem key={day} value={String(day)}>
                  Day {day}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {hasTime && (
          <Input
            type="time"
            className="w-28"
            value={`${pad(parts.hour)}:${pad(parts.minute)}`}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":").map(Number);
              if (h !== undefined && m !== undefined) update({ hour: h, minute: m });
            }}
          />
        )}
        {kind === "hourly" && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            at minute
            <Input
              type="number"
              aria-label="Minute"
              min={0}
              max={59}
              className="w-16"
              value={parts.minute}
              onChange={(e) =>
                update({ minute: Math.min(59, Math.max(0, Number(e.target.value))) })
              }
            />
          </span>
        )}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0 9 * * 1-5"
        className="font-mono"
        spellCheck={false}
        aria-label="Cron expression"
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        dates.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Next: {dates.map((d) => format.format(d)).join(" · ")}
          </p>
        )
      )}
    </div>
  );
}
