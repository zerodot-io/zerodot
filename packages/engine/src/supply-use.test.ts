// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type SupplyUseStatus, trackUse } from "./supply-use";

class Model {
  #calls = 0;
  async chat(text: string) {
    this.#calls++;
    return { text, calls: this.#calls };
  }
}

describe("trackUse", () => {
  it("reports calls of methods, keeps private fields, and leaves plain data as it is", async () => {
    const seen: SupplyUseStatus[] = [];
    const model = trackUse(new Model(), (s) => seen.push(s));
    const turn = await model.chat("hi");
    assert.deepEqual(turn, { text: "hi", calls: 1 });
    assert.deepEqual(structuredClone(turn), turn);
    assert.deepEqual(seen, ["running", "succeeded"]);
  });

  it("reports once for parallel calls, and tracks the tools a tool set opens", async () => {
    const seen: SupplyUseStatus[] = [];
    const set = trackUse(
      {
        open: async () => [{ spec: { name: "a" }, call: async () => "ok" }],
        close: () => undefined,
      },
      (s) => seen.push(s),
    );
    const [tool] = await set.open();
    seen.length = 0;
    await Promise.all([tool?.call(), tool?.call()]);
    assert.deepEqual(seen, ["running", "succeeded"]);
    const failing = trackUse({ call: async () => Promise.reject(new Error("x")) }, (s) =>
      seen.push(s),
    );
    await assert.rejects(failing.call());
    assert.equal(seen.at(-1), "failed");
  });
});
