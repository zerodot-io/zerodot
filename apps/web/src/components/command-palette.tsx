// SPDX-License-Identifier: AGPL-3.0-only
import { useNavigate } from "@tanstack/react-router";
import { Dialog, DialogContent, DialogTitle, Kbd } from "@zerodot/ui";
import { Workflow } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { listWorkflowsFn } from "../server/fns";

export type PaletteAction = {
  id: string;
  group: string;
  label: string;
  icon: ReactNode;
  run: () => void;
};

/** Score a fuzzy match: lower is better, -1 for no match. Substring beats scattered letters. */
function score(label: string, query: string): number {
  if (!query) return 0;
  const l = label.toLowerCase();
  const sub = l.indexOf(query);
  if (sub >= 0) return sub;
  let pos = -1;
  for (const ch of query) {
    pos = l.indexOf(ch, pos + 1);
    if (pos < 0) return -1;
  }
  return 100 + pos;
}

/** Cmd+K (Ctrl+K) palette: jump to pages, workflows, projects. */
export function CommandPalette({ slug, actions }: { slug: string; actions: PaletteAction[] }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fetch on every open so new workflows show up.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    listWorkflowsFn({ data: { projectSlug: slug } })
      .then(setWorkflows)
      .catch(() => setWorkflows([]));
  }, [open, slug]);

  const items = useMemo(() => {
    const flows: PaletteAction[] = workflows.map((w) => ({
      id: `wf:${w.id}`,
      group: "Workflows",
      label: w.name,
      icon: <Workflow className="size-4" />,
      run: () =>
        navigate({
          to: "/p/$projectSlug/workflows/$workflowId",
          params: { projectSlug: slug, workflowId: w.id },
        }),
    }));
    const q = query.trim().toLowerCase();
    const ranked = [...actions, ...flows]
      .map((a) => ({ a, s: score(a.label, q) }))
      .filter((r) => r.s >= 0);
    // Keep groups together. Rank by score within a group when searching.
    const order = [...new Set(ranked.map((r) => r.a.group))];
    ranked.sort((x, y) => order.indexOf(x.a.group) - order.indexOf(y.a.group) || x.s - y.s);
    return ranked.map((r) => r.a);
  }, [actions, workflows, query, slug, navigate]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the active row moves
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  function pick(item: PaletteAction | undefined) {
    if (!item) return;
    setOpen(false);
    item.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(items[index]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="top-[20%] translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search pages, workflows, projects…"
          aria-label="Search"
          className="h-12 border-b bg-transparent px-4 text-base text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 && <p className="px-3 py-6 text-center">No results.</p>}
          {items.map((item, i) => (
            <div key={item.id}>
              {item.group !== items[i - 1]?.group && (
                <p className="px-3 pt-2 pb-1 text-xs font-medium">{item.group}</p>
              )}
              <button
                type="button"
                data-active={i === index}
                onMouseMove={() => setIndex(i)}
                onClick={() => pick(item)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-foreground data-[active=true]:bg-muted"
              >
                <span className="text-muted-foreground">{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t px-4 py-2 text-xs">
          <Kbd>↑↓</Kbd> move <Kbd>↵</Kbd> open <Kbd>esc</Kbd> close
        </div>
      </DialogContent>
    </Dialog>
  );
}
