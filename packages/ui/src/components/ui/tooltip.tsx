// SPDX-License-Identifier: AGPL-3.0-only
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type * as React from "react";

/** Wrap the app once. After one tooltip opens, the next ones open at once. */
function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delay={400} closeDelay={0}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/** Puts a tooltip on one element, for example an icon button. The label is also its name for a screen reader, so set no aria-label. */
function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: string;
  children: React.ReactElement<Record<string, unknown>>;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} aria-label={label} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-50">
          <TooltipPrimitive.Popup className="max-w-72 origin-(--transform-origin) text-pretty rounded-md bg-foreground px-2 py-1 text-background text-xs transition-[opacity,transform] duration-125 ease-out data-ending-style:scale-97 data-ending-style:opacity-0 data-instant:duration-0 data-starting-style:scale-97 data-starting-style:opacity-0">
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export { Tooltip, TooltipProvider };
