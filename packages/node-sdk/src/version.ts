// SPDX-License-Identifier: MIT

/**
 * Version of the node contract (the shape of `NodeDefinition` and what a node can use).
 * A minor version only adds. A major version can break a node package.
 */
export const SDK_VERSION = "1.1.1";

type Version = [number, number, number];

function parse(text: string): Version | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * True when `version` fits `range`. A range is a caret range (`^1.4`, `^1.4.2`) or one exact
 * version (`1.4.2`). A caret range allows the same major version, from the given version up.
 * For major 0 it allows the same minor version only, as npm does.
 */
export function satisfiesSdk(range: string, version: string = SDK_VERSION): boolean {
  const actual = parse(version);
  if (!actual) return false;
  const text = range.trim();
  if (text.startsWith("^")) {
    const floor = parse(text.slice(1));
    if (!floor) return false;
    if (compare(actual, floor) < 0) return false;
    if (actual[0] !== floor[0]) return false;
    return floor[0] !== 0 || actual[1] === floor[1];
  }
  const exact = parse(text);
  return exact !== null && compare(actual, exact) === 0;
}
