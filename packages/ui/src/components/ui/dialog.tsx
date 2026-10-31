import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { useIsMobile } from "../../lib/use-mobile";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  useInDrawer,
} from "./drawer";

const dialogContentVariants = cva(
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-3xl bg-card px-5 pt-4.5 pb-5 text-sm text-muted-foreground shadow-elevation-xl duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
  {
    variants: {
      size: {
        sm: "sm:max-w-sm",
        default: "sm:max-w-md",
        lg: "sm:max-w-2xl",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  // On a phone the dialog is a bottom drawer. One that opens inside another drawer stacks on it.
  if (useIsMobile()) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        {children}
      </Drawer>
    );
  }
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      open={open}
      onOpenChange={onOpenChange && ((next) => onOpenChange(next))}
    >
      {children}
    </DialogPrimitive.Root>
  );
}

function DialogTrigger({ className, ...props }: DialogPrimitive.Trigger.Props) {
  return (
    <DialogPrimitive.Trigger
      data-slot="dialog-trigger"
      className={cn("w-fit", className)}
      {...props}
    />
  );
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/20 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  size = "default",
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props &
  VariantProps<typeof dialogContentVariants> & {
    showCloseButton?: boolean;
  }) {
  if (useInDrawer()) {
    return (
      <DrawerContent showCloseButton={showCloseButton}>
        {/* The scroll is on this inner box. The drawer itself has a cover below it that must not scroll. */}
        <div
          className={cn(
            "mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 text-muted-foreground",
            className,
            // The desktop width and position do not apply to a bottom drawer.
            "static w-full max-w-none translate-x-0 translate-y-0",
          )}
        >
          {children}
        </div>
      </DrawerContent>
    );
  }
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-size={size}
        className={cn(dialogContentVariants({ size }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-xs" />}
          >
            <HugeiconsIcon icon={Cancel01Icon} />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-3", className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  const inDrawer = useInDrawer();
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 rounded-b-xl sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton &&
        (inDrawer ? (
          <DrawerClose asChild>
            <Button variant="outline">Close</Button>
          </DrawerClose>
        ) : (
          <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
        ))}
    </div>
  );
}

const titleClass = "text-xl leading-base font-semibold tracking-normal text-foreground";

function DialogTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  if (useInDrawer()) {
    return <DrawerTitle className={cn(titleClass, "pr-8", className)}>{children}</DrawerTitle>;
  }
  return (
    <DialogPrimitive.Title data-slot="dialog-title" className={cn(titleClass, className)}>
      {children}
    </DialogPrimitive.Title>
  );
}

const descriptionClass =
  "text-base leading-lg tracking-normal text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground";

function DialogDescription({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  if (useInDrawer()) {
    return (
      <DrawerDescription className={cn(descriptionClass, className)}>{children}</DrawerDescription>
    );
  }
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(descriptionClass, className)}
    >
      {children}
    </DialogPrimitive.Description>
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  dialogContentVariants,
};
