// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";

const UNIT_MS = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
} as const;

const MAX_DELAY_MS = 30 * UNIT_MS.days;

const UNITS = ["seconds", "minutes", "hours", "days"] as const;

const unitMeta = (title: string) => ({
  title,
  labels: { seconds: "Seconds", minutes: "Minutes", hours: "Hours", days: "Days" },
  hints: {
    seconds: "A number of seconds",
    minutes: "A number of minutes",
    hours: "A number of hours",
    days: "A number of days. The longest wait is 30 days",
  },
});

/** The time after which a wait for a callback ends. No timeout set: the longest wait. */
export function callbackTimeoutMs(config: {
  timeoutAmount?: number;
  timeoutUnit?: (typeof UNITS)[number];
}): number {
  if (!config.timeoutAmount) return MAX_DELAY_MS;
  return config.timeoutAmount * UNIT_MS[config.timeoutUnit ?? "hours"];
}

export default defineNode({
  type: "flow.delay",
  label: "Wait",
  description: "Pause the workflow for a set time, or until a URL gets a call",
  category: "flow",
  icon: "Timer02Icon",
  config: z
    .object({
      mode: z
        .enum(["time", "webhook"])
        .default("time")
        .meta({
          title: "Resume",
          labels: { time: "After a time", webhook: "On webhook call" },
          hints: {
            time: "Wait for a set time",
            webhook:
              "Wait until a call reaches the resume URL. The method, headers, query, and body of the call are the output",
          },
        }),
      amount: z
        .number()
        .min(0)
        .default(1)
        .meta({ hideWhen: { mode: ["webhook"] } }),
      unit: z
        .enum(UNITS)
        .default("minutes")
        .meta({ ...unitMeta("Unit"), hideWhen: { mode: ["webhook"] } }),
      timeoutAmount: z
        .number()
        .min(0)
        .optional()
        .meta({
          title: "Timeout",
          description: "Optional. When no call comes in this time, the run goes on with timedOut",
          showWhen: { mode: ["webhook"] },
        }),
      timeoutUnit: z
        .enum(UNITS)
        .default("hours")
        .meta({ ...unitMeta("Timeout unit"), showWhen: { mode: ["webhook"] } }),
    })
    .refine(
      (c) =>
        (c.mode === "webhook" ? callbackTimeoutMs(c) : c.amount * UNIT_MS[c.unit]) <= MAX_DELAY_MS,
      "The longest wait is 30 days",
    ),
  defaultConfig: { mode: "time", amount: 1, unit: "minutes" },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => {
    if (config.mode === "webhook") return "On webhook call";
    return typeof config.amount === "number" || typeof config.amount === "string"
      ? `${config.amount} ${String(config.unit ?? "")}`
      : undefined;
  },
  waitsForCallback: (config) => config.mode === "webhook",
  // The node does not wait. The engine stops the run, and the worker resumes it at this time.
  // In webhook mode the time is the timeout. A call to the resume URL ends the wait sooner.
  run: ({ config, input, resumeUrl }) => {
    if (config.mode === "webhook") {
      if (!resumeUrl) {
        throw new Error("This worker cannot wait for a call. Set ZERODOT_BASE_URL on the worker");
      }
      return {
        port: "out",
        data: { timedOut: true },
        waitUntil: Date.now() + callbackTimeoutMs(config),
      };
    }
    return {
      port: "out",
      data: input,
      waitUntil: Date.now() + config.amount * UNIT_MS[config.unit],
    };
  },
});
