// SPDX-License-Identifier: AGPL-3.0-only

const TAGS_URL = "https://api.github.com/repos/zerodot-io/zerodot/tags?per_page=100";
const FOUND_CACHE_MS = 24 * 60 * 60 * 1000;
const FAILED_CACHE_MS = 60 * 60 * 1000;

type Version = [number, number, number];

/** `v1.2.3` or `1.2.3`. Pre-release and other tags are not versions. */
export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The highest release among the tag names, like `0.2.1`. Null when none is a version. */
export function newestVersion(tags: string[]): string | null {
  let best: Version | null = null;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (version && (!best || compare(version, best) > 0)) best = version;
  }
  return best ? best.join(".") : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  return a !== null && b !== null && compare(a, b) > 0;
}

type Options = {
  fetcher?: typeof fetch;
  now?: () => number;
  /** ZERODOT_UPDATE_CHECK=false turns the check off. */
  enabled?: () => boolean;
};

/**
 * Asks GitHub for the newest release tag, at most once a day. It sends nothing about the
 * instance. An error or a timeout gives null, and the next try waits one hour.
 */
export function createUpdateCheck(options: Options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? (() => process.env.ZERODOT_UPDATE_CHECK !== "false");
  let cached: { latest: string | null; until: number } | null = null;

  async function latest(): Promise<string | null> {
    if (cached && now() < cached.until) return cached.latest;
    try {
      const response = await fetcher(TAGS_URL, {
        headers: { accept: "application/vnd.github+json", "user-agent": "zerodot-update-check" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const body: unknown = await response.json();
      const names = Array.isArray(body)
        ? body.flatMap((item) =>
            item &&
            typeof item === "object" &&
            typeof (item as { name?: unknown }).name === "string"
              ? [(item as { name: string }).name]
              : [],
          )
        : [];
      const found = newestVersion(names);
      cached = { latest: found, until: now() + (found ? FOUND_CACHE_MS : FAILED_CACHE_MS) };
    } catch {
      cached = { latest: null, until: now() + FAILED_CACHE_MS };
    }
    return cached.latest;
  }

  /** The newest version when it is newer than `current`. Otherwise null. */
  return async function checkForUpdate(current: string): Promise<string | null> {
    if (!enabled()) return null;
    const found = await latest();
    return found && isNewer(found, current) ? found : null;
  };
}

export const checkForUpdate = createUpdateCheck();
