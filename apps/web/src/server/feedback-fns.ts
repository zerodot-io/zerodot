// SPDX-License-Identifier: AGPL-3.0-only
import { createServerFn } from "@tanstack/react-start";

/**
 * The FeedbackJar widget id from ZERODOT_FEEDBACK_WIDGET_ID. Empty means the widget is off and
 * the browser loads nothing from FeedbackJar. It is read at run time, so one image fits all.
 */
export const getFeedbackWidgetFn = createServerFn({ method: "GET" }).handler(async () => {
  const id = (process.env.ZERODOT_FEEDBACK_WIDGET_ID ?? "").trim();
  return { widgetId: /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null };
});
