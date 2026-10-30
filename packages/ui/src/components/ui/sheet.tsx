import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { useIsMobile } from "../../lib/use-mobile";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Drawer, DrawerContent, DrawerTitle, useInDrawer } from "./drawer";

function Sheet({
  open,
  onOpenChange,
  modal,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Desktop only. The bottom drawer is always modal. */
  modal?: boolean;
  children: React.ReactNode;
}) {
  // On a phone the sheet is a bottom drawer.
  if (useIsMobile()) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        {children}
      </Drawer>
    );
  }
  return (
    <SheetPrimitive.Root
      data-slot="sheet"
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      modal={modal}
    >
      {children}
    </SheetPrimitive.Root>
  );
}

function SheetContent({
  className,
  children,
  container,
  ...props
}: SheetPrimitive.Popup.Props & {
  /** Opens the sheet inside this element, with no backdrop and no shadow. Desktop only. */
  container?: HTMLElement | null;
}) {
  const mobile = useInDrawer();
  if (mobile) return <DrawerContent>{children}</DrawerContent>;
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

function SheetTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  const mobile = useInDrawer();
  if (mobile) return <DrawerTitle className={className}>{children}</DrawerTitle>;
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-semibold text-foreground", className)}
    >
      {children}
    </SheetPrimitive.Title>
  );
}

export { Sheet, SheetContent, SheetHeader, SheetTitle };
