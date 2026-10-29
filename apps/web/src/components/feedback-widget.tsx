// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";

const SDK_URL = "https://cdn.feedbackjar.com/sdk.js";

type Property = string | number | boolean;
type FeedbackUser = { id: string; name: string; email: string };

// The widget is a script from outside. The page sets what it knows, and `apply` hands it over
// when the script is ready, in any order.
let base: Record<string, Property> = {};
let user: FeedbackUser | null = null;
let role: string | null = null;

function apply() {
  if (!window.fj) return;
  window.fj.identify(user);
  window.fj.setProperties(user ? { ...base, ...(role ? { role } : {}) } : null);
}

/**
 * Who sends the feedback, so a request has a name and an email. Pass null on sign out.
 * Display-only: no signed profile, because an instance has no FeedbackJar secret.
 */
export function setFeedbackUser(next: FeedbackUser | null, nextRole: string | null = null) {
  user = next;
  role = nextRole;
  apply();
}

/** Opens the feedback panel. */
export function openFeedback() {
  window.fj?.showWidget();
}

/**
 * Loads the FeedbackJar widget while it is on the page, and removes it when it leaves.
 * `properties` (version, system) go with each feedback.
 */
export function FeedbackWidget({
  widgetId,
  properties,
}: {
  widgetId: string | null;
  properties: Record<string, Property>;
}) {
  useEffect(() => {
    if (!widgetId) return;
    base = properties;
    const start = () => {
      // "custom": no floating button. The Account menu opens the panel.
      window.fj?.init(widgetId, { trigger: "custom" });
      apply();
    };
    if (window.fj) {
      start();
      return () => window.fj?.destroy();
    }
    let script = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = SDK_URL;
      script.async = true;
      document.body.appendChild(script);
    }
    script.addEventListener("load", start, { once: true });
    return () => {
      script.removeEventListener("load", start);
      window.fj?.destroy();
    };
  }, [widgetId, properties]);
  return null;
}
