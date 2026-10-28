// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { csvCellValue, formatCsvLine, parseCsv } from "./csv";

describe("csv", () => {
  it("parses quotes, commas, and line breaks in fields", () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n"l1\nl2",3\n'), [
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["l1\nl2", "3"],
    ]);
  });

  it("skips blank lines and the byte order mark", () => {
    assert.deepEqual(parseCsv("﻿a,b\n\n1,2"), [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps an empty last cell", () => {
    assert.deepEqual(parseCsv("a,b\n1,"), [
      ["a", "b"],
      ["1", ""],
    ]);
  });

  it("formats a line and round-trips", () => {
    const line = formatCsvLine(["a,b", 'q"q', null, 3, { k: 1 }]);
    assert.deepEqual(parseCsv(line)[0], ["a,b", 'q"q', "", "3", '{"k":1}']);
  });

  it("converts cells to column types", () => {
    assert.equal(csvCellValue("number", "4.5"), 4.5);
    assert.equal(csvCellValue("number", "x"), undefined);
    assert.equal(csvCellValue("boolean", "Yes"), true);
    assert.equal(csvCellValue("string", ""), null);
    assert.equal(csvCellValue("date", "2026-01-02"), "2026-01-02T00:00:00.000Z");
    assert.deepEqual(csvCellValue("json", '{"a":1}'), { a: 1 });
    assert.equal(csvCellValue("json", "{bad"), undefined);
  });
});
