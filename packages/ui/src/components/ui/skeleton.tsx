// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils";

/** A placeholder block with a light sweep while content loads. Set its size with `className`. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "relative overflow-hidden rounded-md bg-muted",
        "before:absolute before:inset-0 before:translate-x-[-100%] before:animate-[skeleton-shimmer_1.6s_ease-in-out_infinite] before:bg-linear-to-r before:from-transparent before:via-foreground/6 before:to-transparent motion-reduce:before:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
