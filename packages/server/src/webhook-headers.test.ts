// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sandboxed, workflowHeaders } from "./webhook.server";

describe("workflowHeaders", () => {
  it("keeps normal headers and drops cookies, CORS, and security headers", () => {
    const headers = workflowHeaders({
      "content-type": "text/html",
      "x-custom": "1",
      "Set-Cookie": "session=attacker",
      "access-control-allow-credentials": "true",
      "Content-Security-Policy": "default-src *",
      "x-content-type-options": "off",
      "transfer-encoding": "chunked",
      number: 5,
    });
    assert.deepEqual(headers, { "content-type": "text/html", "x-custom": "1" });
  });

  it("gives no headers for a value that is not an object", () => {
    assert.deepEqual(workflowHeaders(null), {});
    assert.deepEqual(workflowHeaders("x"), {});
  });
});

describe("sandboxed", () => {
  it("adds the sandbox over the headers of the workflow", () => {
    const response = sandboxed(
      new Response("<script>alert(1)</script>", {
        headers: { "content-type": "text/html", "content-security-policy": "default-src *" },
      }),
    );
    assert.equal(response.headers.get("content-security-policy"), "sandbox");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-type"), "text/html");
  });

  it("works on a JSON response", () => {
    const response = sandboxed(Response.json({ ok: true }));
    assert.equal(response.headers.get("content-security-policy"), "sandbox");
  });
});
