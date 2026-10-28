// SPDX-License-Identifier: AGPL-3.0-only

/** Splits CSV text into rows of cells (RFC 4180: quotes, doubled quotes, line breaks in cells). */
export function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("The CSV has a quote that is not closed");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Rows as objects. The first row holds the keys. A short row gets empty text. */
export function parseCsv(text: string, delimiter: string, header: boolean): unknown[] {
  const rows = parseCsvRows(text, delimiter);
  if (!header) return rows;
  const [keys, ...rest] = rows;
  if (!keys) return [];
  return rest.map((cells) => Object.fromEntries(keys.map((key, i) => [key, cells[i] ?? ""])));
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Objects as CSV text. The keys of all objects make the header, in order of first sight. */
export function toCsv(rows: Record<string, unknown>[], delimiter: string, header: boolean): string {
  const keys: string[] = [];
  for (const row of rows)
    for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  const quote = (value: string) =>
    value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines = rows.map((row) => keys.map((key) => quote(cellText(row[key]))).join(delimiter));
  if (header) lines.unshift(keys.map(quote).join(delimiter));
  return lines.join("\n");
}
