// SPDX-License-Identifier: AGPL-3.0-only

/** Release notes are markdown from outside. This reads a small part of it into data, never HTML. */
export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; text: string }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "heading"; inline: Inline[] }
  | { type: "paragraph"; inline: Inline[] }
  | { type: "list"; items: Inline[][] }
  | { type: "code"; text: string };

/** The link as is when it is http or https. Otherwise null. */
export function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;

/** `code`, **bold**, [text](url) and bare links. A link that is not http or https stays text. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const text = (end: number) => {
    if (end > last) out.push({ type: "text", text: source.slice(last, end) });
  };
  for (const m of source.matchAll(INLINE)) {
    const start = m.index ?? 0;
    text(start);
    last = start + m[0].length;
    if (m[1] !== undefined) out.push({ type: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ type: "bold", text: m[2] });
    else {
      const href = safeHref(m[4] ?? m[5] ?? "");
      if (href) out.push({ type: "link", text: m[3] ?? m[5] ?? href, href });
      else out.push({ type: "text", text: m[0] });
    }
  }
  text(source.length);
  return out;
}

/** Headings, bullet lists, fenced code and paragraphs. Anything else is a paragraph. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: Inline[][] | null = null;
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", inline: parseInline(paragraph.join(" ")) });
    }
    if (list) blocks.push({ type: "list", items: list });
    paragraph = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trimEnd();
    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] as string).trimStart().startsWith("```"); i++) {
        code.push(lines[i] as string);
      }
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      blocks.push({ type: "heading", inline: parseInline(heading[1] ?? "") });
    } else if (bullet) {
      if (paragraph.length) flush();
      list = [...(list ?? []), parseInline(bullet[1] ?? "")];
    } else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}
