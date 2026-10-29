// SPDX-License-Identifier: AGPL-3.0-only

const RELEASES_URL = "https://api.github.com/repos/zerodot-io/zerodot/releases?per_page=30";
const CACHE_MS = 60 * 60 * 1000;
const MAX_RELEASES = 10;
const MAX_BODY = 20_000;

export type Release = {
  /** Like `0.2.5`, without the `v`. */
  version: string;
  tag: string;
  name: string;
  publishedAt: string | null;
  /** Markdown. */
  body: string;
  /** The page of the release on GitHub. */
  url: string;
};

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

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  return a !== null && b !== null && compare(a, b) > 0;
}

const parts = (release: Release): Version => parseVersion(release.version) ?? [0, 0, 0];
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The stable releases in a GitHub answer. Drafts, pre-releases and other tags are skipped. */
export function parseReleases(body: unknown): Release[] {
  if (!Array.isArray(body)) return [];
  const releases: Release[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const tag = text(raw.tag_name);
    const parsed = parseVersion(tag);
    if (!parsed || raw.draft === true || raw.prerelease === true) continue;
    releases.push({
      version: parsed.join("."),
      tag,
      name: text(raw.name) || tag,
      publishedAt: text(raw.published_at) || null,
      body: text(raw.body).slice(0, MAX_BODY),
      url: `https://github.com/zerodot-io/zerodot/releases/tag/${encodeURIComponent(tag)}`,
    });
  }
  return releases;
}

type Options = {
  fetcher?: typeof fetch;
  now?: () => number;
  /** ZERODOT_UPDATE_CHECK=false turns the check off. */
  enabled?: () => boolean;
};

/**
 * Asks GitHub for the releases, at most once an hour (with the ETag, so an unchanged list does
 * not use the rate limit). It sends nothing about the instance. An error, a rate limit or a
 * timeout keeps the last list, and the next try waits one hour.
 */
export function createUpdateCheck(options: Options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? (() => process.env.ZERODOT_UPDATE_CHECK !== "false");
  let releases: Release[] = [];
  let etag: string | null = null;
  let until = 0;

  async function load(): Promise<Release[]> {
    if (now() < until) return releases;
    until = now() + CACHE_MS;
    try {
      const response = await fetcher(RELEASES_URL, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "zerodot-update-check",
          ...(etag ? { "if-none-match": etag } : {}),
        },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 304) return releases;
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      releases = parseReleases(await response.json());
      etag = response.headers.get("etag");
    } catch {
      // offline or rate limited: no update, no error
    }
    return releases;
  }

  /** The releases newer than `current`, newest first, at most 10. Empty when none. */
  return async function checkForUpdate(current: string): Promise<Release[]> {
    if (!enabled()) return [];
    return (await load())
      .filter((release) => isNewer(release.version, current))
      .sort((a, b) => compare(parts(b), parts(a)))
      .slice(0, MAX_RELEASES);
  };
}

export const checkForUpdate = createUpdateCheck();
