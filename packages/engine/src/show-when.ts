// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rules that decide when a config field shows in the editor. A condition maps a config key to the
 * values that it accepts. A value is a plain value, or an operator object `{ _cnd: { gte: 1.1 } }`.
 * All keys of one condition must match. A list of conditions needs one match.
 */
export type FieldCondition = Record<string, unknown[]>;

export type ShowRules = {
  showWhen?: FieldCondition | FieldCondition[];
  /** The field hides when one of these conditions holds. This wins over `showWhen`. */
  hideWhen?: FieldCondition | FieldCondition[];
};

const asList = (condition: FieldCondition | FieldCondition[] | undefined): FieldCondition[] =>
  condition === undefined ? [] : Array.isArray(condition) ? condition : [condition];

function operatorMatches(op: string, expected: unknown, actual: unknown): boolean {
  switch (op) {
    case "eq":
      return actual === expected;
    case "not":
      return actual !== expected;
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    case "between": {
      const { from, to } = expected as { from: number; to: number };
      return Number(actual) >= from && Number(actual) <= to;
    }
    case "startsWith":
      return typeof actual === "string" && actual.startsWith(String(expected));
    case "endsWith":
      return typeof actual === "string" && actual.endsWith(String(expected));
    case "includes":
      return typeof actual === "string" && actual.includes(String(expected));
    case "regex":
      return typeof actual === "string" && new RegExp(String(expected)).test(actual);
    case "exists":
      return (actual !== undefined && actual !== null) === Boolean(expected);
    default:
      return false;
  }
}

function matches(accepted: unknown, actual: unknown): boolean {
  if (typeof accepted === "object" && accepted !== null && "_cnd" in accepted) {
    const [op, expected] =
      Object.entries((accepted as { _cnd: Record<string, unknown> })._cnd)[0] ?? [];
    return op !== undefined && operatorMatches(op, expected, actual);
  }
  return Array.isArray(actual) ? actual.includes(accepted) : actual === accepted;
}

function holds(condition: FieldCondition, read: (key: string) => unknown): boolean {
  return Object.entries(condition).every(([key, accepted]) => {
    const actual = read(key);
    return accepted.some((one) => matches(one, actual));
  });
}

/** True when the rules let the field show. `read` gives the current value of a config key. */
export function isVisible(rules: ShowRules, read: (key: string) => unknown): boolean {
  const show = asList(rules.showWhen);
  if (show.length > 0 && !show.some((condition) => holds(condition, read))) return false;
  return !asList(rules.hideWhen).some((condition) => holds(condition, read));
}

/**
 * The credential types of a node that apply for the current config. `types` is
 * `credentialTypes` and `rules` is `credentialRules` of the node.
 */
export function visibleCredentialTypes(
  types: string[],
  rules: Record<string, ShowRules> | undefined,
  read: (key: string) => unknown,
): string[] {
  return types.filter((type) => {
    const rule = rules?.[type];
    return !rule || isVisible(rule, read);
  });
}
