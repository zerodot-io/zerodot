// SPDX-License-Identifier: AGPL-3.0-only
import { createServerFn } from "@tanstack/react-start";

/** The Zerodot widget on FeedbackJar. Users send feature requests there. */
const WIDGET_ID = "cmvt1tjn9000ccwykkocs21fa";

/**
 * The FeedbackJar widget id, or null when ZERODOT_FEEDBACK_WIDGET=false. It is read at run
 * time, so one image fits all.
 */
export const getFeedbackWidgetFn = createServerFn({ method: "GET" }).handler(async () => ({
  widgetId: process.env.ZERODOT_FEEDBACK_WIDGET === "false" ? null : WIDGET_ID,
}));
