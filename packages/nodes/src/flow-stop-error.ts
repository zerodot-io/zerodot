// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";

export default defineNode({
  type: "flow.stop_and_error",
  label: "Stop and Error",
  description: "Fail the workflow with an error message",
  category: "flow",
  icon: "StopCircleIcon",
  config: z.object({
    errorType: z
      .enum(["message", "object"])
      .default("message")
      .meta({
        title: "Error Type",
        labels: { message: "Error Message", object: "Error Object" },
        hints: {
          message: "Fail with a text message",
          object: "Fail with a JSON object. The text of the error is its message field",
        },
      }),
    errorMessage: z
      .string()
      .default("")
      .meta({ title: "Error Message", showWhen: { errorType: ["message"] } }),
    errorObject: z
      .unknown()
      .optional()
      .meta({ title: "Error Object", ui: "fields", showWhen: { errorType: ["object"] } }),
  }),
  defaultConfig: { errorType: "message", errorMessage: "" },
  ports: { in: ["in"], out: [] },
  subtitle: (config) =>
    config.errorType === "message" && typeof config.errorMessage === "string"
      ? config.errorMessage || undefined
      : undefined,
  run: ({ config }) => {
    if (config.errorType === "object") {
      const value = config.errorObject;
      const message =
        typeof value === "object" && value !== null && "message" in value
          ? String((value as { message: unknown }).message)
          : JSON.stringify(value ?? null);
      throw new Error(message);
    }
    throw new Error(config.errorMessage || "The workflow was stopped with an error");
  },
});
