// SPDX-License-Identifier: AGPL-3.0-only

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@zerodot/ui";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { type Block, cleanReleaseNotes, type Inline, parseMarkdown } from "../lib/markdown";
import { getUpdateFn } from "../server/fns";

export type Release = {
  version: string;
  name: string;
  publishedAt: string | null;
  body: string;
  url: string;
};

function Inlines({ items }: { items: Inline[] }) {
  return items.map((item, i) => {
    const key = `${i}:${item.type}`;
    if (item.type === "code") {
      return (
        <code key={key} className="rounded bg-background px-1 font-mono">
          {item.text}
        </code>
      );
    }
    if (item.type === "bold") return <strong key={key}>{item.text}</strong>;
    if (item.type === "link") {
      return (
        <a
          key={key}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {item.text}
        </a>
      );
    }
    return item.text;
  });
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return blocks.map((block, i) => {
    const key = `${i}:${block.type}`;
    if (block.type === "heading") {
      return (
        <p key={key} className="pt-1 text-muted-foreground">
          <Inlines items={block.inline} />
        </p>
      );
    }
    if (block.type === "list") {
      return (
        <ul key={key} className="list-disc space-y-1.5 pl-4 marker:text-muted-foreground">
          {block.items.map((item, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the list never changes
            <li key={j}>
              <Inlines items={item} />
            </li>
          ))}
        </ul>
      );
    }
    if (block.type === "code") {
      return (
        <pre key={key} className="overflow-x-auto rounded bg-background p-2 font-mono">
          {block.text}
        </pre>
      );
    }
    return (
      <p key={key}>
        <Inlines items={block.inline} />
      </p>
    );
  });
}

/** One release as a message: the version and date, the notes, and the link to GitHub. */
function Message({ release }: { release: Release }) {
  const date = release.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : "";
  return (
    <article className="space-y-3 p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium">v{release.version}</h3>
        <a
          href={release.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {date || "GitHub"}
        </a>
      </header>
      <div className="space-y-2 text-pretty break-words">
        <Blocks blocks={parseMarkdown(cleanReleaseNotes(release.body))} />
      </div>
    </article>
  );
}

/** How long the toast stays when nobody opens it. */
const TOAST_MS = 15_000;

/**
 * The orange dot in the bottom-right corner while a newer version exists. It stays until the
 * app is updated. A click shows a small toast, and "View" grows that toast into the release notes.
 */
export function UpdateNotice({ releases }: { releases: Release[] }) {
  const [view, setView] = useState<"closed" | "toast" | "open">("closed");
  const latest = releases[0];

  useEffect(() => {
    if (view !== "toast") return;
    const timer = setTimeout(() => setView("closed"), TOAST_MS);
    return () => clearTimeout(timer);
  }, [view]);

  if (!latest) return null;
  const open = view === "open";
  // A portal to the body, so a transformed parent (the .reveal animation) cannot move the fixed
  // dot and window away from the viewport corner. The releases load in an effect, so this runs
  // only in the browser.
  return createPortal(
    <>
      {/* One box for the toast and the window. The width and the body rows morph between them. */}
      <section
        aria-label={open ? "What's new" : "Update available"}
        inert={view === "closed"}
        className={`fixed right-4 bottom-10 z-50 flex max-w-[calc(100vw-2rem)] origin-bottom-right flex-col overflow-hidden rounded-xl bg-popover text-foreground shadow-elevation-xl ring-1 ring-foreground/10 transition-[width,opacity,translate,scale,visibility] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${open ? "w-96" : "w-72"} ${view === "closed" ? "invisible translate-y-2 scale-95 opacity-0" : ""}`}
      >
        <header className="flex items-center justify-between gap-2 py-1 pr-1 pl-3">
          <h2 role="status" className="truncate font-medium">
            {open ? "What's new" : `Update available: v${latest.version}`}
          </h2>
          <span className="flex shrink-0 items-center gap-1">
            {!open && (
              <Button size="xs" variant="outline" onClick={() => setView("open")}>
                View
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close"
              onClick={() => setView("closed")}
            >
              <HugeiconsIcon icon={Cancel01Icon} />
            </Button>
          </span>
        </header>
        <div
          className={`grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
        >
          <div inert={!open} className="min-h-0 overflow-hidden">
            <div className="max-h-[60vh] overflow-y-auto border-t border-foreground/10">
              <Message release={latest} />
            </div>
          </div>
        </div>
      </section>
      <button
        type="button"
        aria-label={`Update available: v${latest.version}`}
        aria-expanded={open}
        onClick={() => setView((v) => (v === "closed" ? "toast" : "closed"))}
        className="fixed right-2 bottom-2 z-40 grid size-5 place-items-center"
      >
        <span className="update-dot size-2.5 rounded-full bg-orange-500" />
      </button>
    </>,
    document.body,
  );
}

/** The update dot for pages outside the project layout. Only render it for the instance admin. */
export function AdminUpdateNotice() {
  const [releases, setReleases] = useState<Release[]>([]);
  useEffect(() => {
    getUpdateFn({ data: { current: __APP_VERSION__ } })
      .then(({ releases }) => setReleases(releases))
      .catch(() => undefined);
  }, []);
  return <UpdateNotice releases={releases} />;
}
