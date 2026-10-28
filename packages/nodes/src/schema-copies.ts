// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The JSON Schema that a community package sent for a config or for credential fields. zerodot
 * builds a copy of the schema from it, but the copy can lose details. The catalog shows the editor
 * the schema that the package sent.
 */
export const sentSchemas = new WeakMap<object, unknown>();
