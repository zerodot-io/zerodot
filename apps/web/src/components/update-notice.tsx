// SPDX-License-Identifier: AGPL-3.0-only
import { Button, toast } from "@zerodot/ui";
import { X } from "lucide-react";
import { useState } from "react";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown";

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
          className="break-all underline underline-offset-4"
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
        <p key={key} className="font-medium">
          <Inlines items={block.inline} />
        </p>
      );
    }
    if (block.type === "list") {
      return (
        <ul key={key} className="list-disc space-y-1 pl-4">
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
    <article className="space-y-2 rounded-xl bg-muted p-3">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium">v{release.version}</h3>
        <span className="text-muted-foreground">{date}</span>
      </header>
      <div className="space-y-2 break-words">
        <Blocks blocks={parseMarkdown(release.body)} />
      </div>
      <a
        href={release.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-muted-foreground underline underline-offset-4"
      >
        View on GitHub
      </a>
    </article>
  );
}

/**
 * The orange dot in the bottom-right corner while a newer version exists. It stays until the
 * app is updated. A click shows a toast, and "View" opens the release notes in a small window.
 */
export function UpdateNotice({ releases }: { releases: Release[] }) {
  const [open, setOpen] = useState(false);
  const latest = releases[0];
  if (!latest) return null;
  const notify = () =>
    toast(`Update available: v${latest.version}`, {
      duration: 15_000,
      action: { label: "View", onClick: () => setOpen(true) },
    });
  return (
    <>
      {open && (
        <section
          aria-label="What's new"
          className="fixed right-4 bottom-10 z-50 flex h-112 max-h-[70vh] w-96 max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-popover text-popover-foreground shadow-lg"
        >
          <header className="flex items-center justify-between border-b py-1 pr-1 pl-3">
            <h2 className="font-medium">What's new</h2>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
          </header>
          <div className="flex-1 space-y-3 overflow-y-auto p-3">
            {releases.map((release) => (
              <Message key={release.version} release={release} />
            ))}
          </div>
        </section>
      )}
      <button
        type="button"
        aria-label={`Update available: v${latest.version}`}
        onClick={notify}
        className="fixed right-2 bottom-2 z-40 grid size-5 place-items-center"
      >
        <span className="update-dot size-2.5 rounded-full bg-orange-500" />
      </button>
    </>
  );
}
