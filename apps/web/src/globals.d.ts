// SPDX-License-Identifier: AGPL-3.0-only
// Set in vite.config.ts.
declare const __APP_VERSION__: string;

interface Window {
  /** The FeedbackJar widget. It exists after its script has loaded. */
  fj?: {
    init: (widgetId: string, options?: { trigger?: "default" | "custom" }) => void;
    showWidget: () => void;
    destroy: () => void;
    identify: (user: { id: string; name: string; email: string } | null) => void;
    setProperties: (properties: Record<string, string | number | boolean> | null) => void;
  };
}
