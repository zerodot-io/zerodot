// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Small safe expression evaluator. No eval, no new Function, no function calls.
 * Syntax: literals, paths (a.b, a["b"], a[0]), unary ! and -, arithmetic,
 * comparison, && || ??, the ternary operator, `.includes(value)` on lists and text, and the
 * type helpers `.toString()`, `.toNumber()` and `.toBoolean()`.
 */

export class ExpressionError extends Error {
  constructor(
    readonly detail: string,
    readonly path?: string,
  ) {
    super(path ? `${detail} (at ${path})` : detail);
    this.name = "ExpressionError";
  }
}

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "id"; value: string }
  | { kind: "op"; value: string }
  | { kind: "end" };

const OPERATORS = [
  "===",
  "!==",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "?",
  ":",
  ".",
  "[",
  "]",
  "(",
  ")",
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(i));
      const text = match?.[0] ?? ch;
      tokens.push({ kind: "num", value: Number(text) });
      i += text.length;
    } else if (ch === '"' || ch === "'") {
      let out = "";
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\" && i + 1 < source.length) i++;
        out += source[i];
        i++;
      }
      if (source[i] !== ch) throw new ExpressionError("Unterminated string");
      i++;
      tokens.push({ kind: "str", value: out });
    } else if (/[A-Za-z_$]/.test(ch)) {
      const match = /^[A-Za-z0-9_$]+/.exec(source.slice(i));
      const text = match?.[0] ?? ch;
      tokens.push({ kind: "id", value: text });
      i += text.length;
    } else {
      const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
      if (!op) throw new ExpressionError(`Unexpected character "${ch}"`);
      tokens.push({ kind: "op", value: op });
      i += op.length;
    }
  }
  tokens.push({ kind: "end" });
  return tokens;
}

type Node =
  | { type: "lit"; value: unknown }
  | { type: "id"; name: string }
  | { type: "member"; object: Node; key: Node; label: string }
  | { type: "includes"; object: Node; arg: Node }
  | { type: "convert"; object: Node; to: Conversion }
  | { type: "unary"; op: string; arg: Node }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "cond"; test: Node; yes: Node; no: Node };

const CONVERSIONS = ["toString", "toNumber", "toBoolean"] as const;
type Conversion = (typeof CONVERSIONS)[number];

const BINARY_PRECEDENCE: Record<string, number> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "===": 4,
  "!==": 4,
  "<": 5,
  "<=": 5,
  ">": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};

const LITERALS: Record<string, unknown> = {
  true: true,
  false: false,
  null: null,
  undefined: undefined,
};

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private isOp(value: string) {
    const token = this.peek();
    return token.kind === "op" && token.value === value;
  }

  private expectOp(value: string) {
    if (!this.isOp(value)) throw new ExpressionError(`Expected "${value}"`);
    this.pos++;
  }

  parse(): Node {
    const node = this.ternary();
    if (this.peek().kind !== "end") throw new ExpressionError("Unexpected token after expression");
    return node;
  }

  private ternary(): Node {
    const test = this.binary(1);
    if (!this.isOp("?")) return test;
    this.pos++;
    const yes = this.ternary();
    this.expectOp(":");
    const no = this.ternary();
    return { type: "cond", test, yes, no };
  }

  private binary(minPrecedence: number): Node {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token.kind !== "op") break;
      const precedence = BINARY_PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.pos++;
      const right = this.binary(precedence + 1);
      left = { type: "binary", op: token.value, left, right };
    }
    return left;
  }

  private unary(): Node {
    if (this.isOp("!") || this.isOp("-")) {
      const op = (this.peek() as { value: string }).value;
      this.pos++;
      return { type: "unary", op, arg: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let node = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        this.pos++;
        const token = this.peek();
        if (token.kind !== "id") throw new ExpressionError('Expected a name after "."');
        this.pos++;
        node = {
          type: "member",
          object: node,
          key: { type: "lit", value: token.value },
          label: token.value,
        };
      } else if (this.isOp("[")) {
        this.pos++;
        const key = this.ternary();
        this.expectOp("]");
        node = {
          type: "member",
          object: node,
          key,
          label: key.type === "lit" ? String(key.value) : "[…]",
        };
      } else if (this.isOp("(")) {
        if (node.type !== "member" || node.key.type !== "lit") {
          throw new ExpressionError("Function calls are not allowed. Use a code node.");
        }
        const { label } = node;
        const conversion = CONVERSIONS.find((name) => name === label);
        if (conversion) {
          this.pos++;
          this.expectOp(")");
          node = { type: "convert", object: node.object, to: conversion };
        } else if (label === "includes") {
          this.pos++;
          const arg = this.ternary();
          this.expectOp(")");
          node = { type: "includes", object: node.object, arg };
        } else {
          throw new ExpressionError("Function calls are not allowed. Use a code node.");
        }
      } else {
        return node;
      }
    }
  }

  private primary(): Node {
    const token = this.peek();
    this.pos++;
    if (token.kind === "num" || token.kind === "str") return { type: "lit", value: token.value };
    if (token.kind === "id") {
      if (Object.hasOwn(LITERALS, token.value))
        return { type: "lit", value: LITERALS[token.value] };
      return { type: "id", name: token.value };
    }
    if (token.kind === "op" && token.value === "(") {
      const inner = this.ternary();
      this.expectOp(")");
      return inner;
    }
    throw new ExpressionError("Unexpected end or token in expression");
  }
}

/**
 * An object where a missing key is an error, not `undefined`. Used for `$vars`,
 * so a mistyped variable name fails the node and names the keys that are close.
 */
export class StrictRecord {
  constructor(
    readonly label: string,
    readonly values: Record<string, unknown>,
  ) {}
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}

function similarKeys(key: string, keys: string[]): string[] {
  const lower = key.toLowerCase();
  return keys
    .map((k) => ({ k, d: distance(lower, k.toLowerCase()) }))
    .filter(
      ({ k, d }) => d <= 2 || k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()),
    )
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
    .map(({ k }) => k);
}

const CREDENTIAL_REF =
  /\$credentials\[\s*(?:"([^"]+)"|'([^']+)')\s*\](?:\.([A-Za-z_][\w-]*)|\[\s*(?:"([^"]+)"|'([^']+)')\s*\])/g;

/**
 * Credential fields that a text reads as `$credentials["name"].field`. Only this static form is
 * valid, so a workflow shows which credentials it reads. `invalid` is true when the text has a
 * `$credentials` that is not in this form, for example a name that comes from an expression.
 */
export function credentialRefsUsed(text: string): {
  refs: { name: string; field: string }[];
  invalid: boolean;
} {
  const refs: { name: string; field: string }[] = [];
  for (const match of text.matchAll(CREDENTIAL_REF)) {
    const name = match[1] ?? match[2];
    const field = match[3] ?? match[4] ?? match[5];
    if (name && field) refs.push({ name, field });
  }
  const total = text.split("$credentials").length - 1;
  return { refs, invalid: total !== refs.length };
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function readMember(object: unknown, key: unknown, path: string): unknown {
  if (object === null || object === undefined) {
    throw new ExpressionError(`Cannot read "${String(key)}" of ${String(object)}`, path);
  }
  if (typeof key !== "string" && typeof key !== "number") {
    throw new ExpressionError("A key must be a string or a number", path);
  }
  if (typeof key === "string" && FORBIDDEN_KEYS.has(key)) {
    throw new ExpressionError(`Key "${key}" is not allowed`, path);
  }
  if (object instanceof StrictRecord) {
    const name = String(key);
    if (Object.hasOwn(object.values, name)) return object.values[name];
    const similar = similarKeys(name, Object.keys(object.values));
    const hint = similar.length > 0 ? ` Did you mean: ${similar.join(", ")}?` : "";
    throw new ExpressionError(`${object.label} "${name}" does not exist.${hint}`, path);
  }
  if (Array.isArray(object)) {
    if (key === "length") return object.length;
    return typeof key === "number" ? object[key] : undefined;
  }
  if (typeof object === "string") {
    if (key === "length") return object.length;
    return undefined;
  }
  if (typeof object === "object") {
    return Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : undefined;
  }
  return undefined;
}

function numeric(value: unknown, op: string): number {
  if (typeof value !== "number") {
    throw new ExpressionError(`Operator "${op}" needs numbers`);
  }
  return value;
}

function evaluate(node: Node, scope: Record<string, unknown>, path: string): unknown {
  switch (node.type) {
    case "lit":
      return node.value;
    case "id":
      return Object.hasOwn(scope, node.name) ? scope[node.name] : undefined;
    case "member": {
      const object = evaluate(node.object, scope, path);
      const key = evaluate(node.key, scope, path);
      return readMember(object, key, `${path}.${node.label}`.replace(/^\./, ""));
    }
    case "includes": {
      const object = evaluate(node.object, scope, path);
      const arg = evaluate(node.arg, scope, path);
      if (Array.isArray(object)) return object.includes(arg);
      if (typeof object === "string") return typeof arg === "string" && object.includes(arg);
      throw new ExpressionError('"includes" needs a list or text', path);
    }
    case "convert":
      return convert(evaluate(node.object, scope, path), node.to, path);
    case "unary": {
      const value = evaluate(node.arg, scope, path);
      return node.op === "!" ? !value : -numeric(value, "-");
    }
    case "cond":
      return evaluate(node.test, scope, path)
        ? evaluate(node.yes, scope, path)
        : evaluate(node.no, scope, path);
    case "binary": {
      if (node.op === "&&") {
        const left = evaluate(node.left, scope, path);
        return left ? evaluate(node.right, scope, path) : left;
      }
      if (node.op === "||") {
        const left = evaluate(node.left, scope, path);
        return left ? left : evaluate(node.right, scope, path);
      }
      if (node.op === "??") {
        const left = evaluate(node.left, scope, path);
        return left ?? evaluate(node.right, scope, path);
      }
      const left = evaluate(node.left, scope, path);
      const right = evaluate(node.right, scope, path);
      switch (node.op) {
        case "==":
        case "===":
          return left === right;
        case "!=":
        case "!==":
          return left !== right;
        case "<":
          return (left as number) < (right as number);
        case "<=":
          return (left as number) <= (right as number);
        case ">":
          return (left as number) > (right as number);
        case ">=":
          return (left as number) >= (right as number);
        case "+":
          if (typeof left === "string" || typeof right === "string") {
            return `${stringify(left)}${stringify(right)}`;
          }
          return numeric(left, "+") + numeric(right, "+");
        case "-":
          return numeric(left, "-") - numeric(right, "-");
        case "*":
          return numeric(left, "*") * numeric(right, "*");
        case "/":
          return numeric(left, "/") / numeric(right, "/");
        case "%":
          return numeric(left, "%") % numeric(right, "%");
        default:
          throw new ExpressionError(`Unknown operator "${node.op}"`);
      }
    }
  }
}

const FALSE_TEXT = new Set(["0", "false", "no"]);

/** `.toString()`, `.toNumber()` and `.toBoolean()`. A value that cannot convert is an error. */
function convert(value: unknown, to: Conversion, path: string): unknown {
  if (to === "toString") return stringify(value);
  if (to === "toNumber") {
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (Number.isNaN(number)) {
      throw new ExpressionError(
        `Cannot turn ${JSON.stringify(value) ?? "undefined"} into a number`,
        path,
      );
    }
    return number;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  // "0", "false" and "no" are false in any letter case. Other text is true.
  if (typeof value === "string") return !FALSE_TEXT.has(value.trim().toLowerCase());
  throw new ExpressionError(
    `Cannot turn ${JSON.stringify(value) ?? "undefined"} into true or false`,
    path,
  );
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Throws an `ExpressionError` when the source is not valid. Nothing is evaluated. */
export function parseExpression(source: string): void {
  new Parser(tokenize(source)).parse();
}

export function evaluateExpression(source: string, scope: Record<string, unknown>): unknown {
  const ast = new Parser(tokenize(source)).parse();
  return evaluate(ast, scope, "");
}

type Segment = { text: string } | { expression: string };

function splitTemplate(input: string): Segment[] {
  const segments: Segment[] = [];
  let rest = input;
  while (rest.length > 0) {
    const start = rest.indexOf("{{");
    if (start === -1) {
      segments.push({ text: rest });
      break;
    }
    const end = rest.indexOf("}}", start + 2);
    if (end === -1) throw new ExpressionError('Missing "}}"');
    if (start > 0) segments.push({ text: rest.slice(0, start) });
    segments.push({ expression: rest.slice(start + 2, end).trim() });
    rest = rest.slice(end + 2);
  }
  return segments;
}

/** A string with one `` and nothing else keeps the value type. Otherwise the result is text. */
export function resolveTemplate(input: string, scope: Record<string, unknown>): unknown {
  if (!input.includes("{{")) return input;
  const segments = splitTemplate(input);
  const only = segments.length === 1 ? segments[0] : undefined;
  if (only && "expression" in only) return evaluateExpression(only.expression, scope);
  return segments
    .map((s) => ("text" in s ? s.text : stringify(evaluateExpression(s.expression, scope))))
    .join("");
}

/** Resolve every string inside a config value. Errors carry the path to the bad value. */
export function resolveConfig(
  value: unknown,
  scope: Record<string, unknown>,
  path = "config",
): unknown {
  if (typeof value === "string") {
    try {
      return resolveTemplate(value, scope);
    } catch (error) {
      if (error instanceof ExpressionError) {
        const inner = error.path ? ` [${error.path}]` : "";
        throw new ExpressionError(`${error.detail}${inner}`, path);
      }
      throw error;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveConfig(item, scope, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveConfig(item, scope, `${path}.${key}`),
      ]),
    );
  }
  return value;
}
