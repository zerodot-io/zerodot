// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInline, parseMarkdown, safeHref } from "./markdown";

describe("safeHref", () => {
  it("allows http and https only", () => {
    assert.equal(safeHref("https://a.test/x"), "https://a.test/x");
    assert.equal(safeHref("javascript:alert(1)"), null);
    assert.equal(safeHref("data:text/html,x"), null);
    assert.equal(safeHref("/relative"), null);
  });
});

describe("parseInline", () => {
  it("reads code, bold and links", () => {
    assert.deepEqual(parseInline("a `b` **c** [d](https://e.test)"), [
      { type: "text", text: "a " },
      { type: "code", text: "b" },
      { type: "text", text: " " },
      { type: "bold", text: "c" },
      { type: "text", text: " " },
      { type: "link", text: "d", href: "https://e.test/" },
    ]);
  });

  it("keeps an unsafe link as text and never makes HTML", () => {
    const unsafe = parseInline("[x](javascript:alert(1))");
    assert.equal(
      unsafe.some((item) => item.type === "link"),
      false,
    );
    assert.equal(
      unsafe.map((item) => ("text" in item ? item.text : "")).join(""),
      "[x](javascript:alert(1))",
    );
    assert.deepEqual(parseInline("<img src=x onerror=alert(1)>"), [
      { type: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });

  it("links a bare address", () => {
    assert.deepEqual(parseInline("see https://a.test/pull/1"), [
      { type: "text", text: "see " },
      { type: "link", text: "https://a.test/pull/1", href: "https://a.test/pull/1" },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("reads headings, lists, code and paragraphs", () => {
    const blocks = parseMarkdown("## New\n- one\n- two\n\ntext\nmore\n\n```\nx < y\n```");
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["heading", "list", "paragraph", "code"],
    );
    assert.equal(blocks[1]?.type === "list" && blocks[1].items.length, 2);
    assert.equal(blocks[3]?.type === "code" && blocks[3].text, "x < y");
  });
});
