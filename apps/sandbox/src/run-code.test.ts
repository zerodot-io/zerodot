// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodeError, runCode, runCodeWithLogs } from "./run-code";

const run = (code: string, scope: Record<string, unknown> = {}, timeoutMs = 2000) =>
  runCode({ code, scope, timeoutMs });

describe("runCode", () => {
  it("returns a value and reads the scope", async () => {
    const result = await run("return { sum: $input.a + $input.b, who: $trigger.name };", {
      $input: { a: 2, b: 3 },
      $trigger: { name: "Ann" },
    });
    assert.deepEqual(result, { sum: 5, who: "Ann" });
  });

  it("supports await and a result of any JSON type", async () => {
    assert.equal(await run("const x = await Promise.resolve(41); return x + 1;"), 42);
    assert.deepEqual(await run("return [1, 'a', null];"), [1, "a", null]);
    assert.equal(await run("return undefined;"), null);
    assert.equal(await run("// no return"), null);
  });

  it("freezes $vars", async () => {
    const scope = { $vars: { baseUrl: "https://x", nested: { n: 1 } } };
    assert.equal(await run("return $vars.baseUrl;", scope), "https://x");
    await assert.rejects(run("$vars.baseUrl = 'evil';", scope), /read only|Cannot assign/i);
    await assert.rejects(run("$vars.nested.n = 2;", scope), /read only|Cannot assign/i);
  });

  it("has no Node API, network, or timers", async () => {
    const result = await run(
      `return {
        require: typeof require, process: typeof process, fetch: typeof fetch,
        timer: typeof setTimeout, buffer: typeof Buffer, module: typeof module,
        scope: typeof __scope, user: typeof __user,
      };`,
    );
    assert.deepEqual(result, {
      require: "undefined",
      process: "undefined",
      fetch: "undefined",
      timer: "undefined",
      buffer: "undefined",
      module: "undefined",
      scope: "undefined",
      user: "undefined",
    });
  });

  it("does not let the code reach the host through the constructor chain", async () => {
    const result = await run(
      `try { return this?.constructor?.constructor?.("return typeof process")?.() } catch (e) { return "blocked" }`,
    );
    assert.notEqual(result, "object");
  });

  it("stops code that never ends", async () => {
    const started = Date.now();
    await assert.rejects(run("while (true) {}", {}, 300), /took longer than 300 ms/);
    assert.ok(Date.now() - started < 3000);
  });

  it("stops code that uses too much memory", async () => {
    await assert.rejects(
      run("const a = []; while (true) a.push(new Array(1e6).fill(1));", {}, 10_000),
      /memory|stopped/i,
    );
  });

  it("reports errors with a short message", async () => {
    await assert.rejects(run("throw new Error('boom');"), (e: unknown) => {
      return e instanceof CodeError && e.message === "boom";
    });
    await assert.rejects(run("return (;"), /SyntaxError/);
    await assert.rejects(run("return $input.a.b;", { $input: {} }), /undefined/);
  });

  it("rejects a result that is not JSON, or too large", async () => {
    await assert.rejects(run("const a = {}; a.a = a; return a;"), /circular/i);
    await assert.rejects(
      runCode({
        code: "return 'x'.repeat(5000);",
        scope: {},
        timeoutMs: 2000,
        maxOutputBytes: 100,
      }),
      /limit is 100 bytes/,
    );
  });

  it("keeps runs apart", async () => {
    await run("globalThis.leak = 'secret'; return 1;");
    assert.equal(await run("return typeof globalThis.leak;"), "undefined");
  });
});

describe("console", () => {
  const withLogs = (code: string) => runCodeWithLogs({ code, scope: {}, timeoutMs: 2000 });

  it("collects the calls with their level", async () => {
    const { result, logs } = await withLogs(
      `console.log("a", 1, { b: 2 }); console.warn("w"); console.error(new Error("boom").message); return 7;`,
    );
    assert.equal(result, 7);
    assert.deepEqual(logs, [
      { level: "log", message: 'a 1 {"b":2}' },
      { level: "warn", message: "w" },
      { level: "error", message: "boom" },
    ]);
  });

  it("does not fail on a value that is not JSON", async () => {
    const { logs } = await withLogs(
      `const a = {}; a.self = a; console.log(a, undefined, () => 1, 10n === 10n);`,
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0]?.message ?? "", /^\[object Object\] undefined /);
  });

  it("keeps the logs when the code fails", async () => {
    await assert.rejects(withLogs(`console.log("before"); throw new Error("bad");`), (error) => {
      assert.ok(error instanceof CodeError);
      assert.deepEqual(error.logs, [{ level: "log", message: "before" }]);
      return true;
    });
  });

  it("limits the number and size of logs", async () => {
    const { logs } = await withLogs(
      `for (let i = 0; i < 150; i++) console.log("x".repeat(5000)); return 1;`,
    );
    assert.equal(logs.length, 101);
    assert.equal(logs[0]?.message.length, 2000);
    assert.deepEqual(logs[100], { level: "warn", message: "50 more logs dropped" });
  });

  it("does not leak the log hook", async () => {
    assert.equal(await run("return typeof __log;"), "undefined");
  });
});
