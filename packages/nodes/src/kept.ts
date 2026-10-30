// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A value that lives on `globalThis`, so it is the same object when the module runs again. In dev,
 * Vite runs a changed module again (hot reload), and a plain module value starts empty. The
 * nodes and credential types of the loaded packages are kept this way, because the packages load
 * only once, at start.
 */
export function kept<T>(name: string, make: () => T): T {
  const key = Symbol.for(`zerodot.nodes.${name}`);
  const store = globalThis as Record<symbol, unknown>;
  if (!(key in store)) store[key] = make();
  return store[key] as T;
}
