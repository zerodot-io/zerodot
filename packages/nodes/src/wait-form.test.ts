// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWaitForm, renderWaitForm } from "./wait-form";

const form = {
  title: "Review <now>",
  fields: [
    { fieldLabel: "Name", requiredField: true },
    { fieldLabel: "Age", fieldType: "number" as const },
    {
      fieldLabel: "Size",
      fieldType: "dropdown" as const,
      fieldOptions: { values: [{ option: "S" }, { option: "L" }] },
    },
    {
      fieldLabel: "Tags",
      fieldType: "checkbox" as const,
      fieldOptions: { values: [{ option: "a" }, { option: "b" }] },
    },
  ],
};

const data = (pairs: [string, string][]) => {
  const out = new FormData();
  for (const [k, v] of pairs) out.append(k, v);
  return out;
};

describe("wait form", () => {
  it("escapes text and has no script", () => {
    const html = renderWaitForm(form);
    assert.ok(html.includes("Review &#60;now&#62;"));
    assert.ok(!html.includes("<script"));
    assert.ok(html.includes('<form method="post">'));
  });

  it("reads the answers by label", () => {
    const result = parseWaitForm(
      form,
      data([
        ["f0", "Ann"],
        ["f1", "7"],
        ["f2", "L"],
        ["f3", "a"],
        ["f3", "b"],
      ]),
    );
    assert.deepEqual(result, {
      ok: true,
      answers: { Name: "Ann", Age: 7, Size: "L", Tags: ["a", "b"] },
    });
  });

  it("refuses a missing required field, a bad number, and a value that is not in the list", () => {
    assert.equal(parseWaitForm(form, data([])).ok, false);
    assert.equal(
      parseWaitForm(
        form,
        data([
          ["f0", "x"],
          ["f1", "abc"],
        ]),
      ).ok,
      false,
    );
    assert.equal(
      parseWaitForm(
        form,
        data([
          ["f0", "x"],
          ["f2", "XL"],
        ]),
      ).ok,
      false,
    );
  });
});
