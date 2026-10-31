// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ExpressionError,
  evaluateExpression,
  resolveConfig,
  resolveTemplate,
  StrictRecord,
} from "./expression";

const scope = {
  $trigger: { body: { id: 7, tags: ["a", "b"], name: "Ann" } },
  $node: { "Fetch user": { data: { status: 200 } } },
};

describe("expressions", () => {
  it("reads paths", () => {
    assert.equal(evaluateExpression("$trigger.body.id", scope), 7);
    assert.equal(evaluateExpression('$node["Fetch user"].data.status', scope), 200);
    assert.equal(evaluateExpression("$trigger.body.tags[1]", scope), "b");
    assert.equal(evaluateExpression("$trigger.body.tags.length", scope), 2);
  });

  it("does operators", () => {
    assert.equal(evaluateExpression("1 + 2 * 3", scope), 7);
    assert.equal(evaluateExpression("$trigger.body.id == 7 && true", scope), true);
    assert.equal(evaluateExpression("$trigger.body.id > 10 ? 'big' : 'small'", scope), "small");
    assert.equal(evaluateExpression("$trigger.body.missing ?? 'x'", scope), "x");
    assert.equal(evaluateExpression("!false", scope), true);
  });

  it("converts types with toString, toNumber and toBoolean", () => {
    assert.equal(evaluateExpression("$trigger.body.id.toString()", scope), "7");
    assert.equal(evaluateExpression("$trigger.body.tags.toString()", scope), '["a","b"]');
    assert.equal(evaluateExpression('"42".toNumber()', scope), 42);
    assert.equal(evaluateExpression('" 1.5 ".toNumber() + 1', scope), 2.5);
    assert.equal(evaluateExpression("true.toNumber()", scope), 1);
    assert.equal(evaluateExpression("$trigger.body.id.toBoolean()", scope), true);
    assert.equal(evaluateExpression("0.toBoolean()", scope), false);
    assert.equal(evaluateExpression('"No".toBoolean()', scope), false);
    assert.equal(evaluateExpression('"false".toBoolean()', scope), false);
    assert.equal(evaluateExpression('"yes".toBoolean()', scope), true);
    assert.throws(() => evaluateExpression('"abc".toNumber()', scope), ExpressionError);
    assert.throws(() => evaluateExpression('"".toNumber()', scope), ExpressionError);
    assert.throws(() => evaluateExpression("null.toBoolean()", scope), ExpressionError);
    assert.throws(
      () => evaluateExpression("$trigger.body.id.toUpperCase()", scope),
      ExpressionError,
    );
  });

  it("keeps the number type of a single expression, and makes text with toString", () => {
    assert.equal(resolveTemplate("{{ $trigger.body.id }}", scope), 7);
    assert.equal(resolveTemplate("{{ $trigger.body.id.toString() }}", scope), "7");
  });

  it("supports includes and length", () => {
    assert.equal(evaluateExpression('$trigger.body.tags.includes("b")', scope), true);
    assert.equal(evaluateExpression('$trigger.body.tags.includes("z")', scope), false);
    assert.equal(evaluateExpression('$trigger.body.name.includes("nn")', scope), true);
    assert.equal(evaluateExpression('!$trigger.body.tags.includes("z")', scope), true);
    assert.equal(evaluateExpression("$trigger.body.tags.length", scope), 2);
    assert.throws(() => evaluateExpression("$trigger.body.id.includes(1)", scope), /needs a list/);
  });

  it("blocks prototype access and calls", () => {
    assert.throws(() => evaluateExpression("$trigger.constructor", scope), ExpressionError);
    assert.throws(() => evaluateExpression('$trigger["__proto__"]', scope), ExpressionError);
    assert.throws(
      () => evaluateExpression("$trigger.body.name.toUpperCase()", scope),
      /not allowed/,
    );
  });

  it("errors on reads of undefined", () => {
    assert.throws(() => evaluateExpression("$trigger.nope.deeper", scope), /Cannot read "deeper"/);
  });

  it("keeps the type for a single expression and joins text otherwise", () => {
    assert.equal(resolveTemplate("{{ $trigger.body.id }}", scope), 7);
    assert.equal(resolveTemplate("https://x/{{ $trigger.body.id }}/y", scope), "https://x/7/y");
  });

  it("reports the config path", () => {
    assert.throws(
      () => resolveConfig({ headers: { a: "{{ $trigger.nope.x }}" } }, scope),
      (error: unknown) => error instanceof ExpressionError && error.path === "config.headers.a",
    );
  });

  it("fails on a missing variable and names the close keys", () => {
    const vars = new StrictRecord("Variable", { baseUrl: "https://x", teamId: 7 });
    const withVars = { $vars: vars };
    assert.equal(evaluateExpression("$vars.baseUrl", withVars), "https://x");
    assert.throws(
      () => evaluateExpression("$vars.baseURL", withVars),
      /Variable "baseURL" does not exist\. Did you mean: baseUrl\?/,
    );
    assert.throws(
      () => evaluateExpression("$vars.zzz", withVars),
      (error: unknown) =>
        error instanceof ExpressionError && error.detail === 'Variable "zzz" does not exist.',
    );
    assert.equal(evaluateExpression('$vars["teamId"]', withVars), 7);
  });
});

describe("$fromAI", () => {
  it("reads the tool input, and fails outside a tool", async () => {
    const { ToolInput, fromAICalls } = await import("./expression");
    assert.equal(
      resolveTemplate('{{ $fromAI("to", "Who") }}', { $fromAI: new ToolInput({ to: "Ada" }) }),
      "Ada",
    );
    assert.throws(() => resolveTemplate('{{ $fromAI("to") }}', {}), /works only when the node/);
    assert.throws(
      () => resolveTemplate('{{ $fromAI("to") }}', { $fromAI: new ToolInput({}) }),
      /did not give "to"/,
    );
    assert.deepEqual(fromAICalls(`a {{ $fromAI('x', "d", "json") }}`), {
      calls: [{ key: "x", description: "d", type: "json" }],
      invalid: false,
    });
    assert.equal(fromAICalls('{{ $fromAI("x", "d", "date") }}').error, "Invalid type: date");
    // The arguments are text: an expression as a key is the key "$input.a".
    assert.deepEqual(fromAICalls("{{ $fromAI($input.a) }}").calls, [
      { key: "$input.a", description: "", type: "string" },
    ]);
  });

  it("reads quotes, any case, and a default of the type", async () => {
    const { ToolInput, fromAICalls } = await import("./expression");
    assert.deepEqual(fromAICalls("{{ $FROMAI(`k`, 'it\\'s', \"Number\", 5) }}").calls, [
      { key: "k", description: "it's", type: "number", defaultValue: 5 },
    ]);
    const defaults = (type: string, value: string) =>
      fromAICalls(`{{ $fromAI("k", "", "${type}", ${value}) }}`).calls[0]?.defaultValue;
    assert.equal(defaults("boolean", '"TRUE"'), true);
    assert.equal(defaults("number", '"x"'), "x");
    assert.deepEqual(defaults("json", "'[1]'"), [1]);
    assert.equal(defaults("string", "7"), "7");
    assert.match(fromAICalls('{{ $fromAI("x" }}').error ?? "", /^Unbalanced parentheses/);
    // The model left the key out: the default is used.
    assert.equal(
      resolveTemplate('{{ $fromAI("n", "", "number", 5) + 1 }}', {
        $fromAI: new ToolInput({}),
      }),
      6,
    );
  });
});
