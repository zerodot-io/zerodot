// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphSchema, inputPortsOf } from "@zerodot/engine";
import { registry, validateGraphNodes } from "./index";

const signal = new AbortController().signal;
const definition = registry.get("data.merge");
if (!definition) throw new Error("missing data.merge");

async function merge(config: Record<string, unknown>, input: unknown) {
  const result = await definition?.run({
    config: definition.config.parse(config),
    input,
    credential: null,
    signal,
    scope: {},
    sandbox: null,
    tables: null,
  });
  return result?.data;
}

const byField = (config: Record<string, unknown>, input1: unknown, input2: unknown) =>
  merge({ mode: "combineByField", ...config }, { input1, input2 });

describe("data.merge ports", () => {
  it("has two inputs by default, with the old names", () => {
    assert.deepEqual(inputPortsOf(definition, {}), ["input1", "input2"]);
    assert.deepEqual(definition.ports.in, ["input1", "input2"]);
  });
  for (let n = 2; n <= 10; n++) {
    it(`derives ${n} inputs`, () => {
      const ports = inputPortsOf(definition, { numberInputs: n });
      assert.equal(ports.length, n);
      assert.equal(ports[n - 1], `input${n}`);
    });
  }
  it("clamps and tolerates bad values", () => {
    assert.equal(inputPortsOf(definition, { numberInputs: 1 }).length, 2);
    assert.equal(inputPortsOf(definition, { numberInputs: 99 }).length, 10);
    assert.equal(inputPortsOf(definition, { numberInputs: "x" }).length, 2);
    assert.equal(inputPortsOf(definition, { numberInputs: "4" }).length, 4);
    assert.equal(inputPortsOf(definition, { numberInputs: 3.9 }).length, 3);
  });
  it("rejects a count outside 2 to 10 in the schema", () => {
    assert.throws(() => definition.config.parse({ numberInputs: 1 }));
    assert.throws(() => definition.config.parse({ numberInputs: 11 }));
  });
});

describe("data.merge append", () => {
  it("appends N inputs in order", async () => {
    assert.deepEqual(
      await merge(
        { mode: "append", numberInputs: 4 },
        { input1: [1], input2: [2, 3], input3: 4, input4: [] },
      ),
      [1, 2, 3, 4],
    );
  });
  it("leaves out inputs with no data and handles empty input", async () => {
    assert.deepEqual(await merge({ mode: "append", numberInputs: 3 }, { input3: [9] }), [9]);
    assert.deepEqual(await merge({ mode: "append" }, {}), []);
    assert.deepEqual(await merge({ mode: "append" }, null), []);
    assert.deepEqual(await merge({ mode: "append" }, { input1: null, input2: null }), []);
  });
  it("ignores data on a port that is gone", async () => {
    assert.deepEqual(await merge({ mode: "append" }, { input1: [1], input3: [3] }), [1]);
  });
});

describe("data.merge combineByPosition", () => {
  it("merges items by index, unpaired included by default", async () => {
    assert.deepEqual(
      await merge(
        { mode: "combineByPosition" },
        { input1: [{ a: 1 }, { a: 2 }, { a: 3 }], input2: [{ b: 1 }] },
      ),
      [{ a: 1, b: 1 }, { a: 2 }, { a: 3 }],
    );
  });
  it("includes unpaired items of the shorter first input", async () => {
    assert.deepEqual(
      await merge(
        { mode: "combineByPosition" },
        { input1: [{ a: 1 }], input2: [{ b: 1 }, { b: 2 }] },
      ),
      [{ a: 1, b: 1 }, { b: 2 }],
    );
  });
  it("drops unpaired items when asked", async () => {
    assert.deepEqual(
      await merge(
        { mode: "combineByPosition", includeUnpaired: false },
        { input1: [{ a: 1 }, { a: 2 }], input2: [{ b: 1 }] },
      ),
      [{ a: 1, b: 1 }],
    );
  });
  it("merges N inputs", async () => {
    const input = {
      input1: [{ a: 1 }, { a: 2 }],
      input2: [{ b: 1 }],
      input3: [{ c: 1 }, { c: 2 }, { c: 3 }],
    };
    assert.deepEqual(await merge({ mode: "combineByPosition", numberInputs: 3 }, input), [
      { a: 1, b: 1, c: 1 },
      { a: 2, c: 2 },
      { c: 3 },
    ]);
    assert.deepEqual(
      await merge({ mode: "combineByPosition", numberInputs: 3, includeUnpaired: false }, input),
      [{ a: 1, b: 1, c: 1 }],
    );
  });
  it("skips an input with no data", async () => {
    assert.deepEqual(
      await merge(
        { mode: "combineByPosition", numberInputs: 3, includeUnpaired: false },
        { input1: [{ a: 1 }], input3: [{ c: 1 }, { c: 2 }] },
      ),
      [{ a: 1, c: 1 }],
    );
  });
  it("handles empty and non-list inputs", async () => {
    assert.deepEqual(await merge({ mode: "combineByPosition" }, {}), []);
    assert.deepEqual(await merge({ mode: "combineByPosition" }, { input1: [], input2: [] }), []);
    assert.deepEqual(
      await merge({ mode: "combineByPosition" }, { input1: { a: 1 }, input2: { b: 2 } }),
      [{ a: 1, b: 2 }],
    );
    assert.deepEqual(
      await merge({ mode: "combineByPosition" }, { input1: [1, 2], input2: [3] }),
      [3, 2],
    );
  });
  it("settles clashes: prefer 2 by default", async () => {
    assert.deepEqual(
      await merge({ mode: "combineByPosition" }, { input1: [{ k: 1, a: 1 }], input2: [{ k: 2 }] }),
      [{ k: 2, a: 1 }],
    );
  });
  it("settles clashes: prefer 1", async () => {
    assert.deepEqual(
      await merge(
        { mode: "combineByPosition", clash: "preferInput1" },
        { input1: [{ k: 1, a: 1 }], input2: [{ k: 2, b: 2 }] },
      ),
      [{ k: 1, a: 1, b: 2 }],
    );
  });
  it("settles clashes: suffix, and keeps equal values once", async () => {
    assert.deepEqual(
      await merge(
        { mode: "combineByPosition", clash: "suffix" },
        { input1: [{ k: 1, same: 5, a: 1 }], input2: [{ k: 2, same: 5, b: 2 }] },
      ),
      [{ k_1: 1, same: 5, a: 1, k_2: 2, b: 2 }],
    );
    assert.deepEqual(
      await merge(
        { mode: "combineByPosition", clash: "suffix", suffix1: "-a", suffix2: "-b" },
        { input1: [{ k: 1 }], input2: [{ k: 2 }] },
      ),
      [{ "k-a": 1, "k-b": 2 }],
    );
  });
  it("merges nested objects deep or shallow", async () => {
    const input = {
      input1: [{ o: { a: 1, n: { x: 1 } }, l: [1] }],
      input2: [{ o: { b: 2, n: { y: 2 } }, l: [2] }],
    };
    assert.deepEqual(await merge({ mode: "combineByPosition" }, input), [
      { o: { b: 2, n: { y: 2 } }, l: [2] },
    ]);
    assert.deepEqual(await merge({ mode: "combineByPosition", nested: "deep" }, input), [
      { o: { a: 1, b: 2, n: { x: 1, y: 2 } }, l: [2] },
    ]);
    assert.deepEqual(
      await merge({ mode: "combineByPosition", nested: "deep", clash: "preferInput1" }, input),
      [{ o: { a: 1, b: 2, n: { x: 1, y: 2 } }, l: [1] }],
    );
  });
  it("does not pollute prototypes", async () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
    const data = (await merge(
      { mode: "combineByPosition", nested: "deep" },
      { input1: [hostile], input2: [JSON.parse('{"__proto__": {"x": 1}}')] },
    )) as object[];
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(({} as Record<string, unknown>).x, undefined);
    assert.equal(Object.getPrototypeOf(data[0]), Object.prototype);
  });
});

describe("data.merge combineAll", () => {
  it("makes the cross join", async () => {
    assert.deepEqual(
      await merge(
        { mode: "combineAll" },
        { input1: [{ a: 1 }, { a: 2 }], input2: [{ b: 1 }, { b: 2 }] },
      ),
      [
        { a: 1, b: 1 },
        { a: 1, b: 2 },
        { a: 2, b: 1 },
        { a: 2, b: 2 },
      ],
    );
  });
  it("is empty when an input is empty", async () => {
    assert.deepEqual(await merge({ mode: "combineAll" }, { input1: [{ a: 1 }], input2: [] }), []);
    assert.deepEqual(await merge({ mode: "combineAll" }, { input1: [], input2: [{ a: 1 }] }), []);
    assert.deepEqual(await merge({ mode: "combineAll" }, {}), []);
  });
  it("passes one connected input through and wraps a single value", async () => {
    assert.deepEqual(await merge({ mode: "combineAll" }, { input2: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepEqual(await merge({ mode: "combineAll" }, { input1: { a: 1 }, input2: { b: 1 } }), [
      { a: 1, b: 1 },
    ]);
  });
  it("combines all N inputs", async () => {
    const data = (await merge(
      { mode: "combineAll", numberInputs: 3 },
      {
        input1: [{ a: 1 }, { a: 2 }],
        input2: [{ b: 1 }, { b: 2 }],
        input3: [{ c: 1 }, { c: 2 }, { c: 3 }],
      },
    )) as unknown[];
    assert.equal(data.length, 12);
    assert.deepEqual(data[0], { a: 1, b: 1, c: 1 });
    assert.deepEqual(data[11], { a: 2, b: 2, c: 3 });
  });
  it("settles clashes", async () => {
    const input = { input1: [{ k: 1 }], input2: [{ k: 2 }] };
    assert.deepEqual(await merge({ mode: "combineAll", clash: "preferInput1" }, input), [{ k: 1 }]);
    assert.deepEqual(await merge({ mode: "combineAll" }, input), [{ k: 2 }]);
    assert.deepEqual(await merge({ mode: "combineAll", clash: "suffix" }, input), [
      { k_1: 1, k_2: 2 },
    ]);
  });
});

describe("data.merge combineByField", () => {
  const left = [
    { id: 1, a: "x" },
    { id: 2, a: "y" },
    { id: 3, a: "z" },
  ];
  const right = [
    { id: 2, b: "Y" },
    { id: 4, b: "W" },
    { id: 3, b: "Z" },
  ];
  const pair = { matchFields: [{ field1: "id" }] };

  it("keeps matches", async () => {
    assert.deepEqual(await byField(pair, left, right), [
      { id: 2, a: "y", b: "Y" },
      { id: 3, a: "z", b: "Z" },
    ]);
  });
  it("keeps non-matches from both inputs", async () => {
    assert.deepEqual(await byField({ ...pair, join: "keepNonMatches" }, left, right), [
      { id: 1, a: "x" },
      { id: 4, b: "W" },
    ]);
  });
  it("enriches input 1", async () => {
    assert.deepEqual(await byField({ ...pair, join: "enrichInput1" }, left, right), [
      { id: 1, a: "x" },
      { id: 2, a: "y", b: "Y" },
      { id: 3, a: "z", b: "Z" },
    ]);
  });
  it("enriches input 2", async () => {
    assert.deepEqual(await byField({ ...pair, join: "enrichInput2" }, left, right), [
      { id: 2, a: "y", b: "Y" },
      { id: 4, b: "W" },
      { id: 3, a: "z", b: "Z" },
    ]);
  });
  it("keeps everything", async () => {
    assert.deepEqual(await byField({ ...pair, join: "keepEverything" }, left, right), [
      { id: 1, a: "x" },
      { id: 2, a: "y", b: "Y" },
      { id: 3, a: "z", b: "Z" },
      { id: 4, b: "W" },
    ]);
  });
  it("includes all matches, or the first only", async () => {
    const dupes = [
      { id: 1, b: "first" },
      { id: 1, b: "second" },
    ];
    const one = [{ id: 1, a: 1 }];
    assert.deepEqual(await byField(pair, one, dupes), [
      { id: 1, a: 1, b: "first" },
      { id: 1, a: 1, b: "second" },
    ]);
    assert.deepEqual(await byField({ ...pair, multipleMatches: "first" }, one, dupes), [
      { id: 1, a: 1, b: "first" },
    ]);
  });
  it("matches several items of input 1 with one item of input 2", async () => {
    assert.deepEqual(
      await byField(
        pair,
        [
          { id: 1, a: 1 },
          { id: 1, a: 2 },
        ],
        [{ id: 1, b: 1 }],
      ),
      [
        { id: 1, a: 1, b: 1 },
        { id: 1, a: 2, b: 1 },
      ],
    );
  });
  it("matches all pairs of several fields", async () => {
    const config = { matchFields: [{ field1: "a" }, { field1: "b" }] };
    assert.deepEqual(
      await byField(
        config,
        [
          { a: 1, b: 1, x: "yes" },
          { a: 1, b: 2, x: "no" },
        ],
        [{ a: 1, b: 1, y: 1 }],
      ),
      [{ a: 1, b: 1, x: "yes", y: 1 }],
    );
  });
  it("uses the name of input 1 for input 2 unless the names differ", async () => {
    const l = [{ id: 1, a: 1 }];
    const r = [{ id: 9, uid: 1, b: 2 }];
    assert.deepEqual(await byField({ matchFields: [{ field1: "id", field2: "uid" }] }, l, r), []);
    assert.deepEqual(
      await byField({ matchFields: [{ field1: "id", field2: "uid" }], differentNames: true }, l, r),
      [{ id: 9, a: 1, uid: 1, b: 2 }],
    );
  });
  it("reads nested paths and array indexes", async () => {
    assert.deepEqual(
      await byField(
        { matchFields: [{ field1: "user.id", field2: "tags.0" }], differentNames: true },
        [{ user: { id: 7 }, a: 1 }],
        [{ tags: [7, 8], b: 2 }],
      ),
      [{ user: { id: 7 }, a: 1, tags: [7, 8], b: 2 }],
    );
  });
  it("can disable dot notation", async () => {
    const l = [{ "a.b": 1, x: 1 }];
    const r = [{ "a.b": 1, y: 1 }];
    const config = { matchFields: [{ field1: "a.b" }] };
    assert.deepEqual(await byField(config, l, r), []);
    assert.deepEqual(await byField({ ...config, disableDotNotation: true }, l, r), [
      { "a.b": 1, x: 1, y: 1 },
    ]);
    assert.deepEqual(
      await byField({ ...config, disableDotNotation: true }, [{ a: { b: 1 } }], r),
      [],
    );
  });
  it("is strict about types unless fuzzy compare is on", async () => {
    const l = [{ id: "1", a: 1 }];
    const r = [{ id: 1, b: 2 }];
    assert.deepEqual(await byField(pair, l, r), []);
    assert.deepEqual(await byField({ ...pair, fuzzyCompare: true }, l, r), [{ id: 1, a: 1, b: 2 }]);
    assert.deepEqual(
      await byField({ ...pair, fuzzyCompare: true }, [{ id: "true" }], [{ id: true }]),
      [{ id: true }],
    );
    assert.deepEqual(
      await byField({ ...pair, fuzzyCompare: true }, [{ id: "1" }], [{ id: "2" }]),
      [],
    );
  });
  it("does not match missing or null fields", async () => {
    assert.deepEqual(
      await byField(pair, [{ a: 1 }, { id: null, a: 2 }], [{ b: 1 }, { id: null }]),
      [],
    );
    assert.deepEqual(await byField({ ...pair, join: "keepEverything" }, [{ a: 1 }], [{ b: 1 }]), [
      { a: 1 },
      { b: 1 },
    ]);
  });
  it("matches 0, false and empty text", async () => {
    assert.deepEqual(
      await byField(
        pair,
        [
          { id: 0, a: 1 },
          { id: "", a: 2 },
          { id: false, a: 3 },
        ],
        [
          { id: 0, b: 1 },
          { id: "", b: 2 },
          { id: false, b: 3 },
        ],
      ),
      [
        { id: 0, a: 1, b: 1 },
        { id: "", a: 2, b: 2 },
        { id: false, a: 3, b: 3 },
      ],
    );
  });
  it("matches objects by value", async () => {
    assert.deepEqual(await byField(pair, [{ id: { x: [1] }, a: 1 }], [{ id: { x: [1] }, b: 2 }]), [
      { id: { x: [1] }, a: 1, b: 2 },
    ]);
  });
  it("handles empty and non-list inputs", async () => {
    assert.deepEqual(await byField(pair, [], []), []);
    assert.deepEqual(await byField(pair, undefined, undefined), []);
    assert.deepEqual(await byField({ ...pair, join: "enrichInput1" }, [{ id: 1 }], []), [
      { id: 1 },
    ]);
    assert.deepEqual(await byField({ ...pair, join: "enrichInput2" }, [], [{ id: 1 }]), [
      { id: 1 },
    ]);
    assert.deepEqual(await byField({ ...pair, join: "keepNonMatches" }, [{ id: 1 }], undefined), [
      { id: 1 },
    ]);
    assert.deepEqual(await byField(pair, { id: 1, a: 1 }, { id: 1, b: 2 }), [
      { id: 1, a: 1, b: 2 },
    ]);
  });
  it("handles non-object items", async () => {
    assert.deepEqual(await byField({ matchFields: [{ field1: "" }] }, [1, 2], [2, 3]), []);
    assert.deepEqual(await byField(pair, [1, "a"], [2]), []);
  });
  it("settles clashes", async () => {
    const l = [{ id: 1, k: "one" }];
    const r = [{ id: 1, k: "two" }];
    assert.deepEqual(await byField(pair, l, r), [{ id: 1, k: "two" }]);
    assert.deepEqual(await byField({ ...pair, clash: "preferInput1" }, l, r), [
      { id: 1, k: "one" },
    ]);
    // The matched key is not a clash: it has one value.
    assert.deepEqual(await byField({ ...pair, clash: "suffix" }, l, r), [
      { id: 1, k_1: "one", k_2: "two" },
    ]);
  });
  it("merges nested objects deep", async () => {
    assert.deepEqual(
      await byField(
        { ...pair, nested: "deep" },
        [{ id: 1, o: { a: 1 } }],
        [{ id: 1, o: { b: 2 } }],
      ),
      [{ id: 1, o: { a: 1, b: 2 } }],
    );
  });
  it("uses input 1 and 2 only when there are more inputs", async () => {
    assert.deepEqual(
      await merge(
        { mode: "combineByField", numberInputs: 3, ...pair },
        { input1: [{ id: 1 }], input2: [{ id: 1, b: 1 }], input3: [{ id: 1, c: 1 }] },
      ),
      [{ id: 1, b: 1 }],
    );
  });

  describe("old configs", () => {
    it("still works with field1, field2 and keepMatches", async () => {
      const config = { mode: "combineByField", field1: "id", field2: "uid", join: "keepMatches" };
      assert.deepEqual(
        await merge(config, {
          input1: [
            { id: 1, a: 1 },
            { id: 2, a: 2 },
          ],
          input2: [{ uid: 1, b: 9 }],
        }),
        [{ id: 1, a: 1, uid: 1, b: 9 }],
      );
    });
    it("keepAll keeps the unmatched items of input 1, in place", async () => {
      assert.deepEqual(
        await merge(
          { mode: "combineByField", field1: "id", field2: "id", join: "keepAll" },
          { input1: [{ id: 0 }, { id: 1, a: 1 }, { id: 2 }], input2: [{ id: 1, b: 2 }] },
        ),
        [{ id: 0 }, { id: 1, a: 1, b: 2 }, { id: 2 }],
      );
    });
    it("defaults to the field id", async () => {
      assert.deepEqual(
        await merge(
          { mode: "combineByField" },
          { input1: [{ id: 1, a: 1 }], input2: [{ id: 1, b: 1 }] },
        ),
        [{ id: 1, a: 1, b: 1 }],
      );
    });
    it("an old chooseBranch config works", async () => {
      assert.equal(await merge({ mode: "chooseBranch", output: "input2" }, { input2: 5 }), 5);
    });
    it("a parsed old config has no list of fields", () => {
      const parsed = definition.config.parse({
        mode: "combineByField",
        field1: "a",
        field2: "b",
      }) as Record<string, unknown>;
      assert.equal(parsed.matchFields, undefined);
      assert.equal(parsed.numberInputs, 2);
    });
  });
});

describe("data.merge chooseBranch", () => {
  it("passes on the chosen input", async () => {
    for (let n = 1; n <= 10; n++) {
      const input = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`input${i + 1}`, [i + 1]]),
      );
      assert.deepEqual(
        await merge({ mode: "chooseBranch", numberInputs: 10, output: `input${n}` }, input),
        [n],
      );
    }
  });
  it("outputs empty data", async () => {
    assert.deepEqual(await merge({ mode: "chooseBranch", output: "empty" }, { input1: [1] }), []);
  });
  it("gives null when the chosen input has no data", async () => {
    assert.equal(await merge({ mode: "chooseBranch", output: "input2" }, { input1: [1] }), null);
    assert.equal(await merge({ mode: "chooseBranch" }, null), null);
  });
  it("keeps falsy data", async () => {
    assert.equal(await merge({ mode: "chooseBranch" }, { input1: 0 }), 0);
  });
});

describe("data.merge graph check", () => {
  const base = {
    position: { x: 0, y: 0 },
    credentialId: null,
    pinned: null,
    onError: "fail" as const,
  };
  const graph = (numberInputs: number, toPort: string) =>
    graphSchema.parse({
      schema: 1,
      nodes: [
        { ...base, id: "t", type: "trigger.manual", name: "Start", config: {} },
        { ...base, id: "m", type: "data.merge", name: "Merge", config: { numberInputs } },
      ],
      edges: [{ id: "e", from: "t", fromPort: "out", to: "m", toPort }],
    });

  for (let n = 2; n <= 10; n++) {
    it(`accepts an edge into input ${n} when there are ${n} inputs`, () => {
      assert.deepEqual(validateGraphNodes(graph(n, `input${n}`)), []);
    });
  }
  it("flags an edge into an input that the count removed", () => {
    const problems = validateGraphNodes(graph(3, "input4"));
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /no input port "input4"/);
  });
  it("flags a bad count in the config", () => {
    assert.ok(validateGraphNodes(graph(11, "input1")).some((p) => p.includes("numberInputs")));
  });
  it("keeps accepting the two old input ports", () => {
    assert.deepEqual(validateGraphNodes(graph(2, "input1")), []);
    assert.deepEqual(validateGraphNodes(graph(2, "input2")), []);
  });
});
