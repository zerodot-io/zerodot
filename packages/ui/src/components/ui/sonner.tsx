// SPDX-License-Identifier: AGPL-3.0-only
import { Toaster as Sonner, toast } from "sonner";

function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
    />
  );
}

export { Toaster, toast };
