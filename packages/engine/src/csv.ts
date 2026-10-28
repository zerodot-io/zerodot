// SPDX-License-Identifier: AGPL-3.0-only

/** Parse CSV (RFC 4180): quoted fields, doubled quotes, and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A blank line is not a row.
  return rows.filter((r) => r.length > 1 || (r[0] ?? "") !== "");
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text;
}

export function formatCsvLine(values: unknown[]): string {
  return values.map(csvField).join(",");
}

/**
 * Text from a CSV cell to a value of a column type. An empty cell is null.
 * Returns `undefined` when the text does not fit the type.
 */
export function csvCellValue(
  type: "string" | "number" | "boolean" | "date" | "json",
  raw: string,
): unknown {
  if (raw === "") return null;
  switch (type) {
    case "string":
      return raw;
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean": {
      const t = raw.trim().toLowerCase();
      if (t === "true" || t === "1" || t === "yes") return true;
      if (t === "false" || t === "0" || t === "no") return false;
      return undefined;
    }
    case "date": {
      const time = new Date(raw).getTime();
      return Number.isNaN(time) ? undefined : new Date(time).toISOString();
    }
    case "json":
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
  }
}
