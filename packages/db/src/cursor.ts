// SPDX-License-Identifier: AGPL-3.0-only

export type Page<T> = { items: T[]; nextCursor: string | null };

type Cursor = { createdAt: string; id: string };

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  const cursor: Cursor = { createdAt: row.createdAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(raw: string): { createdAt: Date; id: string } {
  const parsed: Cursor = JSON.parse(Buffer.from(raw, "base64url").toString());
  return { createdAt: new Date(parsed.createdAt), id: parsed.id };
}

export function pageOf<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
