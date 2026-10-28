// SPDX-License-Identifier: AGPL-3.0-only
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Refresh route data when the server sends an event. Many events in a short time
 * cause one refresh. The browser reconnects with Last-Event-ID by itself.
 */
export function useRefreshOnEvents(url: string | null, events: string[], debounceMs: number) {
  const router = useRouter();
  const eventKey = events.join(",");
  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void router.invalidate(), debounceMs);
    };
    for (const name of eventKey.split(",")) source.addEventListener(name, refresh);
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [url, router, debounceMs, eventKey]);
}
