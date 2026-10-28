// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { fileIcon } from "./icon";

describe("fileIcon", () => {
  it("returns a data URL for a file next to the caller", () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-icon-"));
    try {
      writeFileSync(join(dir, "a.svg"), "<svg/>");
      const from = pathToFileURL(join(dir, "index.js")).href;
      assert.equal(fileIcon(from, "./a.svg"), `data:image/svg+xml;base64,${btoa("<svg/>")}`);
      assert.throws(() => fileIcon(from, "./a.gif"), /must be/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
