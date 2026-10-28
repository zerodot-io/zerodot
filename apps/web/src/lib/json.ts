// SPDX-License-Identifier: AGPL-3.0-only

/** Server functions can only return values the serializer can prove are safe. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Values from jsonb columns are JSON by construction. */
export const asJson = (value: unknown): Json => value as Json;
