// SPDX-License-Identifier: AGPL-3.0-only
import { CronExpressionParser } from "cron-parser";

/** Returns an error message, or null when the expression and time zone are valid. */
export function validateCron(expression: string, timezone: string): string | null {
  try {
    // cron-parser does not check the time zone, so check it here.
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    CronExpressionParser.parse(expression, { tz: timezone });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
