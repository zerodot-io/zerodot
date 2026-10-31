import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { cn } from "../../lib/utils";
import { Button } from "./button";

/** True inside a drawer root. Sheet and dialog parts use it to pick the drawer parts on a phone. */
const InDrawerContext = React.createContext(false);
/** Set inside open drawer content. A drawer that opens there calls it, and the content behind steps back. */
const NestContext = React.createContext<((open: boolean) => void) | null>(null);

/** The open drawer content. Popups render in it, so the drawer focus trap and pointer lock allow them. */
const PortalContainerContext = React.createContext<HTMLElement | null>(null);

function useInDrawer() {
  return React.useContext(InDrawerContext);
}

function usePortalContainer() {
  return React.useContext(PortalContainerContext) ?? undefined;
}

function Drawer({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  // Not vaul NestedRoot: it steps the parent back only when its own trigger opens it.
  const stepBack = React.useContext(NestContext);
  const open = props.open === true;
  React.useEffect(() => {
    if (!(stepBack && open)) return;
    stepBack(true);
    return () => stepBack(false);
  }, [stepBack, open]);
  return (
    <InDrawerContext.Provider value={true}>
      <DrawerPrimitive.Root data-slot="drawer" {...props} />
    </InDrawerContext.Provider>
  );
}

/** A bottom sheet. Drag the handle down to close it. */
function DrawerContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & { showCloseButton?: boolean }) {
  const [content, setContent] = React.useState<HTMLDivElement | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  // The same step back as vaul NestedRoot.
  const stepBack = React.useCallback(
    (open: boolean) => {
      if (!content) return;
      clearTimeout(timer.current);
      const scale = open ? (window.innerWidth - 16) / window.innerWidth : 1;
      content.style.transition = "transform 0.5s cubic-bezier(0.32, 0.72, 0, 1)";
      content.style.transform = `scale(${scale}) translate3d(0, ${open ? -16 : 0}px, 0)`;
      if (!open) {
        timer.current = setTimeout(() => {
          content.style.transition = "";
          content.style.transform = "";
        }, 500);
      }
    },
    [content],
  );
  return (
    <DrawerPrimitive.Portal>
      <DrawerPrimitive.Overlay
        data-slot="drawer-overlay"
        className="fixed inset-0 z-50 bg-black/20"
      />
      <DrawerPrimitive.Content
        ref={setContent}
        data-slot="drawer-content"
        aria-describedby={undefined}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[85svh] flex-col rounded-t-2xl border-t bg-card pb-[env(safe-area-inset-bottom)] text-sm outline-none",
          className,
        )}
        {...props}
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted" />
        <NestContext.Provider value={stepBack}>
          <PortalContainerContext.Provider value={content}>
            {children}
          </PortalContainerContext.Provider>
        </NestContext.Provider>
        {showCloseButton && (
          <DrawerPrimitive.Close asChild>
            <Button variant="ghost" className="absolute top-3 right-2" size="icon-xs">
              <HugeiconsIcon icon={Cancel01Icon} />
              <span className="sr-only">Close</span>
            </Button>
          </DrawerPrimitive.Close>
        )}
      </DrawerPrimitive.Content>
    </DrawerPrimitive.Portal>
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  );
}

const DrawerDescription = DrawerPrimitive.Description;
const DrawerClose = DrawerPrimitive.Close;

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  useInDrawer,
  usePortalContainer,
};
