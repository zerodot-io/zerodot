import { useSyncExternalStore } from "react";

/** Below the Tailwind `md` breakpoint. */
const QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True on a phone-size screen. The server render is always false. */
export function useIsMobile() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
