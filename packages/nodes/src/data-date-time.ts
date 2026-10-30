// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { isRecord } from "./list-common";

const UNITS = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"] as const;
type Unit = (typeof UNITS)[number];
const FIXED_MS: Partial<Record<Unit, number>> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

function parse(value: string): Date {
  const date =
    value === "" || value === "now"
      ? new Date()
      : new Date(/^\d+$/.test(value) ? Number(value) : value);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a valid date: "${value}"`);
  return date;
}

function add(date: Date, amount: number, unit: Unit): Date {
  const fixed = FIXED_MS[unit];
  if (fixed) return new Date(date.getTime() + amount * fixed);
  const next = new Date(date);
  if (unit === "months") next.setUTCMonth(next.getUTCMonth() + amount);
  else next.setUTCFullYear(next.getUTCFullYear() + amount);
  return next;
}

function startOf(date: Date, unit: Unit): Date {
  const next = new Date(date);
  if (unit === "years") next.setUTCMonth(0, 1);
  if (unit === "months") next.setUTCDate(1);
  if (unit === "weeks") next.setUTCDate(next.getUTCDate() - ((next.getUTCDay() + 6) % 7));
  const levels: Unit[] = ["years", "months", "weeks", "days", "hours", "minutes", "seconds"];
  const at = levels.indexOf(unit);
  if (at >= 3) next.setUTCHours(0, 0, 0, 0);
  if (at >= 4) next.setUTCHours(date.getUTCHours(), 0, 0, 0);
  if (at >= 5) next.setUTCMinutes(date.getUTCMinutes(), 0, 0);
  if (at >= 6) next.setUTCSeconds(date.getUTCSeconds(), 0);
  if (at < 3) next.setUTCHours(0, 0, 0, 0);
  return next;
}

function diff(a: Date, b: Date, unit: Unit): number {
  const fixed = FIXED_MS[unit];
  if (fixed) return (b.getTime() - a.getTime()) / fixed;
  const months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return unit === "months" ? months : months / 12;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Formats in UTC. Tokens: YYYY YY MMMM MM DD dddd HH mm ss SSS. */
function format(date: Date, pattern: string): string {
  const tokens: Record<string, string> = {
    YYYY: pad(date.getUTCFullYear(), 4),
    YY: pad(date.getUTCFullYear() % 100),
    MMMM: MONTHS[date.getUTCMonth()] ?? "",
    MM: pad(date.getUTCMonth() + 1),
    DD: pad(date.getUTCDate()),
    dddd: DAYS[date.getUTCDay()] ?? "",
    HH: pad(date.getUTCHours()),
    mm: pad(date.getUTCMinutes()),
    ss: pad(date.getUTCSeconds()),
    SSS: pad(date.getUTCMilliseconds(), 3),
  };
  return pattern.replace(/YYYY|YY|MMMM|MM|DD|dddd|HH|mm|ss|SSS/g, (t) => tokens[t] ?? t);
}

export default defineNode({
  type: "data.dateTime",
  label: "Date & Time",
  description: "Manipulate date and time values",
  category: "data",
  actions: [
    { label: "Get the current date", config: { action: "now" } },
    { label: "Add time to a date", config: { action: "add" } },
    { label: "Subtract time from a date", config: { action: "subtract" } },
    { label: "Round a date to the start", config: { action: "startOf" } },
    { label: "Get the difference between dates", config: { action: "difference" } },
    { label: "Format a date", config: { action: "format" } },
    { label: "Convert a date to a timestamp", config: { action: "toTimestamp" } },
  ],
  icon: "Calendar01Icon",
  config: z.object({
    action: z
      .enum(["now", "add", "subtract", "startOf", "difference", "format", "toTimestamp"])
      .default("format")
      .meta({
        title: "Action",
        labels: {
          now: "Get Current Date",
          add: "Add Time",
          subtract: "Subtract Time",
          startOf: "Round to Start",
          difference: "Get Difference",
          format: "Format Date",
          toTimestamp: "To Timestamp",
        },
        hints: {
          now: "Get the date and time now",
          add: "Add an amount of time to a date",
          subtract: "Subtract an amount of time from a date",
          startOf: "Go to the start of the day, month, or other unit",
          difference: "Get the time between two dates",
          format: "Write a date in a pattern",
          toTimestamp: "Get the date as a number of milliseconds",
        },
      }),
    // A date text (ISO 8601), a number of milliseconds, or "now". Empty means now.
    date: z.string().default(""),
    // difference: the second date.
    other: z.string().default(""),
    amount: z.number().default(1),
    unit: z
      .enum(UNITS)
      .default("days")
      .meta({
        title: "Unit",
        labels: {
          seconds: "Seconds",
          minutes: "Minutes",
          hours: "Hours",
          days: "Days",
          weeks: "Weeks",
          months: "Months",
          years: "Years",
        },
      }),
    // format: the pattern. Times are UTC.
    pattern: z.string().default("YYYY-MM-DD HH:mm:ss"),
    outputField: z.string().min(1).default("result"),
  }),
  defaultConfig: {
    action: "format",
    date: "{{ $input.date }}",
    other: "",
    amount: 1,
    unit: "days",
    pattern: "YYYY-MM-DD HH:mm:ss",
    outputField: "result",
  },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => (typeof config.action === "string" ? config.action : undefined),
  run: ({ config, input }) => {
    const date = parse(config.date);
    let result: string | number;
    switch (config.action) {
      case "now":
        result = new Date().toISOString();
        break;
      case "add":
        result = add(date, config.amount, config.unit).toISOString();
        break;
      case "subtract":
        result = add(date, -config.amount, config.unit).toISOString();
        break;
      case "startOf":
        result = startOf(date, config.unit).toISOString();
        break;
      case "difference":
        result = diff(date, parse(config.other), config.unit);
        break;
      case "format":
        result = format(date, config.pattern);
        break;
      case "toTimestamp":
        result = date.getTime();
        break;
    }
    const base = isRecord(input) ? input : {};
    return { port: "out", data: { ...base, [config.outputField]: result } };
  },
});
