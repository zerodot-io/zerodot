import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "../../lib/utils";
import { usePortalContainer } from "./drawer";

export type ComboboxOption = { value: string; label: string };

/** A select with a search field. The person types to filter the list. */
function Combobox({
  id,
  items,
  value,
  onValueChange,
  disabled,
  placeholder = "Search",
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  items: ComboboxOption[];
  value: string;
  onValueChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const selected = items.find((item) => item.value === value) ?? null;
  return (
    <ComboboxPrimitive.Root<ComboboxOption>
      items={items}
      value={selected}
      disabled={disabled}
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      onValueChange={(next) => {
        if (next) onValueChange(next.value);
      }}
    >
      <div className={cn("relative w-64", className)}>
        <ComboboxPrimitive.Input
          id={id}
          aria-label={ariaLabel}
          placeholder={placeholder}
          onFocus={(event) => event.currentTarget.select()}
          className="h-8 w-full min-w-0 rounded-md bg-transparent py-2 pr-8 pl-2.5 text-base text-secondary-foreground shadow-default outline-none transition-shadow duration-150 placeholder:text-muted-foreground hover:shadow-raised focus:shadow-[0px_1px_1px_rgba(0,0,0,0.12),0px_0px_0px_1px_rgba(0,0,0,0.1)] disabled:pointer-events-none disabled:opacity-50"
        />
        <ComboboxPrimitive.Trigger
          aria-label="Show options"
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} className="size-4" />
        </ComboboxPrimitive.Trigger>
      </div>
      <ComboboxPrimitive.Portal container={usePortalContainer()}>
        <ComboboxPrimitive.Positioner sideOffset={4} className="isolate z-50">
          <ComboboxPrimitive.Popup className="w-(--anchor-width) min-w-56 overflow-hidden rounded-xl bg-card text-muted-foreground shadow-elevation-xl">
            <ComboboxPrimitive.Empty className="p-3 text-base empty:hidden">
              No match
            </ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List className="max-h-72 overflow-y-auto p-1">
              {(item: ComboboxOption) => (
                <ComboboxPrimitive.Item
                  key={item.value}
                  value={item}
                  className="flex cursor-default items-center rounded-md px-2 py-1.5 text-base text-secondary-foreground outline-hidden select-none data-highlighted:bg-secondary data-selected:font-medium"
                >
                  {item.label}
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}

export { Combobox };
