// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv, toCsv } from "./csv";
import { registry } from "./index";
import { parseFeed } from "./rss-read";

const signal = new AbortController().signal;

async function run(type: string, config: Record<string, unknown>, input: unknown = null) {
  const definition = registry.get(type);
  if (!definition) throw new Error(`missing ${type}`);
  const result = await definition.run({
    config: definition.config.parse(config),
    input,
    credential: null,
    signal,
    scope: {},
    sandbox: null,
    tables: null,
  });
  return result.data;
}

describe("flow.stop_and_error", () => {
  it("fails with the message", async () => {
    await assert.rejects(run("flow.stop_and_error", { errorMessage: "bad" }), /bad/);
  });
  it("fails with the message field of an object", async () => {
    await assert.rejects(
      run("flow.stop_and_error", { errorType: "object", errorObject: { message: "obj", code: 1 } }),
      /obj/,
    );
  });
});

describe("data.xml", () => {
  const xml = '<root><a id="1">hi</a><b>1</b><b>2</b></root>';
  it("reads XML", async () => {
    const data = await run("data.xml", { mode: "xmlToJson", value: xml });
    assert.deepEqual(data, { root: { a: { "@_id": "1", "#text": "hi" }, b: [1, 2] } });
  });
  it("always uses arrays when asked", async () => {
    const data = (await run("data.xml", { value: "<r><a>x</a></r>", explicitArray: true })) as {
      r: unknown[];
    };
    assert.ok(Array.isArray(data.r));
  });
  it("rejects bad XML", async () => {
    await assert.rejects(run("data.xml", { value: "<a><b></a>" }), /not valid/);
  });
  it("writes XML", async () => {
    const data = (await run("data.xml", {
      mode: "jsonToXml",
      value: { a: { "@_id": "1", "#text": "hi" } },
    })) as { data: string };
    assert.match(data.data, /<root>\s*<a id="1">hi<\/a>\s*<\/root>/);
  });
});

describe("data.html_extract", () => {
  const html = '<h1>Title</h1><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul>';
  it("gets text of the first match", async () => {
    const data = await run("data.html_extract", { html, selectors: { t: "h1", l: "li a" } });
    assert.deepEqual(data, { t: "Title", l: "A" });
  });
  it("gets an attribute of every match", async () => {
    const data = await run("data.html_extract", {
      html,
      selectors: { links: "li a" },
      returnValue: "attribute",
      returnArray: true,
    });
    assert.deepEqual(data, { links: ["/a", "/b"] });
  });
  it("gives null for no match", async () => {
    const data = await run("data.html_extract", { html, selectors: { x: ".none" } });
    assert.deepEqual(data, { x: null });
  });
  it("reads the data field of the input", async () => {
    const data = await run("data.html_extract", { html: { data: html }, selectors: { t: "h1" } });
    assert.deepEqual(data, { t: "Title" });
  });
});

describe("rss feed", () => {
  it("reads RSS 2.0", () => {
    const items = parseFeed(
      "<rss><channel><item><title>A</title></item><item><title>B</title></item></channel></rss>",
    );
    assert.deepEqual(
      items.map((i) => i.title),
      ["A", "B"],
    );
  });
  it("reads Atom", () => {
    const items = parseFeed(
      '<feed><entry><title>A</title><link href="http://x/a"/><id>1</id></entry></feed>',
    );
    assert.equal(items[0]?.link, "http://x/a");
    assert.equal(items[0]?.title, "A");
  });
  it("rejects other XML", () => {
    assert.throws(() => parseFeed("<html></html>"), /not an RSS/);
  });
});

describe("csv", () => {
  it("parses quotes and line breaks", () => {
    const rows = parseCsv('a,b\n"x,1","he said ""hi""\nnow"\r\n3,4\n', ",", true);
    assert.deepEqual(rows, [
      { a: "x,1", b: 'he said "hi"\nnow' },
      { a: "3", b: "4" },
    ]);
  });
  it("round trips", () => {
    const rows = [
      { a: "x,y", b: 'q"r' },
      { a: "1", c: "z" },
    ];
    const text = toCsv(rows, ",", true);
    assert.equal(text, 'a,b,c\n"x,y","q""r",\n1,,z');
    assert.equal(parseCsv(text, ",", true).length, 2);
  });
  it("fails on an open quote", () => {
    assert.throws(() => parseCsv('a\n"x', ",", true), /not closed/);
  });
});

describe("file nodes", () => {
  it("converts to a CSV file and back", async () => {
    const out = (await run("file.convert_to", {
      format: "csv",
      list: [{ a: 1, b: "x" }],
    })) as { binary: { data: { fileName: string; mimeType: string } } };
    assert.equal(out.binary.data.fileName, "file.csv");
    assert.equal(out.binary.data.mimeType, "text/csv");
    const back = await run("file.extract_from", { format: "csv" }, out);
    assert.deepEqual(back, [{ a: "1", b: "x" }]);
  });
  it("converts text and reads JSON", async () => {
    const text = await run("file.convert_to", { format: "text", text: "hello" });
    assert.deepEqual(await run("file.extract_from", { format: "text" }, text), { data: "hello" });
    const json = await run("file.convert_to", { format: "json", list: [{ a: 1 }] });
    assert.deepEqual(await run("file.extract_from", { format: "json" }, json), [{ a: 1 }]);
  });
  it("fails without the binary property", async () => {
    await assert.rejects(run("file.extract_from", { format: "text" }, {}), /no binary data/);
  });
  it("compresses and decompresses", async () => {
    const file = await run("file.convert_to", { format: "text", text: "hello hello hello" });
    const zipped = (await run("file.compress", { operation: "compress" }, file)) as {
      binary: { data: { fileName: string } };
    };
    assert.equal(zipped.binary.data.fileName, "file.txt.gz");
    const plain = (await run("file.compress", { operation: "decompress" }, zipped)) as {
      binary: { data: { fileName: string } };
    };
    assert.equal(plain.binary.data.fileName, "file.txt");
    assert.deepEqual(await run("file.extract_from", { format: "text" }, plain), {
      data: "hello hello hello",
    });
  });
  it("rejects bad gzip", async () => {
    const file = await run("file.convert_to", { format: "text", text: "nope" });
    await assert.rejects(
      run("file.compress", { operation: "decompress" }, file),
      /not a valid gzip/,
    );
  });
});
