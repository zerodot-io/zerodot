import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetContent({
  className,
  children,
  container,
  ...props
}: SheetPrimitive.Popup.Props & {
  /** Opens the sheet inside this element, with no backdrop and no shadow. */
  container?: HTMLElement | null;
}) {
  const contained = container !== undefined;
  if (contained && !container) return null;
  return (
    <SheetPrimitive.Portal container={container}>
      {!contained && (
        <SheetPrimitive.Backdrop
          data-slot="sheet-overlay"
          className="fixed inset-0 isolate z-50 bg-black/20 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
      )}
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "inset-y-0 right-0 z-50 flex w-96 max-w-full flex-col border-l bg-card text-sm duration-200 outline-none data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
          contained ? "absolute" : "fixed shadow-elevation-xl",
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close
          data-slot="sheet-close"
          render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-xs" />}
        >
          <HugeiconsIcon icon={Cancel01Icon} />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-3 border-b p-4 pr-12", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  );
}

export { Sheet, SheetContent, SheetHeader, SheetTitle };
