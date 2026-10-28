// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, type ReactNode, useContext } from "react";

/** The search text of the data view. Empty when no search is active. */
export const SearchContext = createContext("");

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text with each match of the search text marked. */
export function Marked({ text }: { text: string }) {
  const query = useContext(SearchContext).trim();
  if (!query) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(escape(query), "gi"))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <mark key={match.index} className="rounded-sm bg-amber-200 text-inherit dark:bg-amber-500/40">
        {match[0]}
      </mark>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
