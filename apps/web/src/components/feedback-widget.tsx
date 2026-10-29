// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";

const SDK_URL = "https://cdn.feedbackjar.com/sdk.js";

/** Loads the FeedbackJar widget once. Nothing loads without a widget id. */
export function FeedbackWidget({ widgetId }: { widgetId: string | null }) {
  useEffect(() => {
    if (!widgetId) return;
    const start = () => window.fj?.init(widgetId);
    if (window.fj) {
      start();
      return;
    }
    let script = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = SDK_URL;
      script.async = true;
      document.body.appendChild(script);
    }
    script.addEventListener("load", start, { once: true });
  }, [widgetId]);
  return null;
}
