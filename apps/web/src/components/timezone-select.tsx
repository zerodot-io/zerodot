// SPDX-License-Identifier: AGPL-3.0-only

import { Combobox } from "@zerodot/ui";

const INHERIT = "__inherit";

const ZONES: string[] = (() => {
  try {
    return ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  } catch {
    return ["UTC"];
  }
})();

/** The time zone of the browser, or UTC. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Picks an IANA time zone. The value is empty when the choice is `inheritLabel`.
 * Without `inheritLabel`, a value is always chosen.
 */
export function TimezoneSelect({
  id,
  value,
  onChange,
  inheritLabel,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  inheritLabel?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const zones = value && !ZONES.includes(value) ? [value, ...ZONES] : ZONES;
  const items = [
    ...(inheritLabel ? [{ value: INHERIT, label: inheritLabel }] : []),
    ...zones.map((zone) => ({ value: zone, label: zone })),
  ];
  return (
    <Combobox
      id={id}
      aria-label={ariaLabel}
      className={className ?? "w-64"}
      items={items}
      value={value || (inheritLabel ? INHERIT : "UTC")}
      disabled={disabled}
      placeholder="Search time zones"
      onValueChange={(next) => onChange(next === INHERIT ? "" : next)}
    />
  );
}
