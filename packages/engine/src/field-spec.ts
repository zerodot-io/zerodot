// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldCondition } from "./show-when";

/**
 * An optional icon for an item with a label, for example the option of a select. The editor shows
 * `iconUrl` when it is set, and `icon` if not. Add it to other labelled items with `& ItemIcon`.
 */
export type ItemIcon = {
  /** Name of a Hugeicons icon, for example "Globe02Icon". */
  icon?: string;
  /** Image as a data URL. It replaces `icon`. */
  iconUrl?: string;
};

/**
 * The shape of a nested field (a collection or a fixed collection), as plain data. A node writes
 * it into the JSON Schema of its config. The editor draws a form from it.
 * A key of a condition that starts with "/" reads from the top level of the config.
 */
export type FieldSpec = {
  name: string;
  label: string;
  kind: "string" | "number" | "boolean" | "options" | "filter" | "collection" | "fixed";
  description?: string;
  placeholder?: string;
  default?: unknown;
  multiline?: boolean;
  options?: ({ value: string | number | boolean; label: string; hint?: string } & ItemIcon)[];
  show?: FieldCondition | FieldCondition[];
  hide?: FieldCondition;
  /** `collection`: the fields that the user can add. */
  fields?: FieldSpec[];
  /** `fixed`: the groups. A group holds a list when `multiple` is set, or one object. */
  groups?: { name: string; label: string; fields: FieldSpec[] }[];
  multiple?: boolean;
};
