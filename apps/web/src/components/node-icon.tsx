// SPDX-License-Identifier: AGPL-3.0-only
import type { ItemIcon } from "@zerodot/engine";
import { cn } from "@zerodot/ui";
import {
  ArrowUpDown,
  CalendarClock,
  CalendarDays,
  Circle,
  Code,
  Combine,
  CopyX,
  Database,
  FileArchive,
  FileCode,
  FileInput,
  FileOutput,
  FilePen,
  FileSearch,
  Filter,
  FolderOpen,
  GitBranch,
  Globe,
  HardDrive,
  Image,
  KeyRound,
  ListEnd,
  ListPlus,
  type LucideIcon,
  Mail,
  Merge,
  MousePointerClick,
  OctagonX,
  Package,
  PenLine,
  Plug,
  RefreshCw,
  Repeat,
  Replace,
  Reply,
  Rss,
  Search,
  Send,
  Sigma,
  Signpost,
  Split,
  TableProperties,
  Terminal,
  TextCursorInput,
  Timer,
  Trash2,
  TriangleAlert,
  Webhook,
} from "lucide-react";

// Add an icon here when a node uses a new one. Importing the whole set would make the bundle big.
const ICONS: Record<string, LucideIcon> = {
  Package,
  Mail,
  Database,
  ArrowUpDown,
  CalendarClock,
  CalendarDays,
  Merge,
  Combine,
  CopyX,
  Filter,
  KeyRound,
  ListEnd,
  Sigma,
  TextCursorInput,
  Code,
  Circle,
  FilePen,
  FileArchive,
  FileCode,
  FileInput,
  FileOutput,
  FileSearch,
  OctagonX,
  Rss,
  ListPlus,
  PenLine,
  Plug,
  RefreshCw,
  Repeat,
  Reply,
  Replace,
  Search,
  Send,
  Signpost,
  Split,
  TableProperties,
  Trash2,
  Timer,
  GitBranch,
  Globe,
  HardDrive,
  FolderOpen,
  Image,
  Terminal,
  MousePointerClick,
  TriangleAlert,
  Webhook,
};

const CATEGORY_COLOR: Record<string, string> = {
  trigger: "text-amber-500",
  logic: "text-violet-500",
  data: "text-sky-500",
  flow: "text-emerald-500",
  code: "text-rose-500",
  integration: "text-indigo-500",
};

const CHIP_COLOR: Record<string, string> = {
  trigger: "text-amber-700 dark:text-amber-400",
  logic: "text-violet-700 dark:text-violet-400",
  data: "text-sky-700 dark:text-sky-400",
  flow: "text-emerald-700 dark:text-emerald-400",
  code: "text-rose-700 dark:text-rose-400",
  integration: "text-indigo-700 dark:text-indigo-400",
};

/**
 * `tile` is the large icon inside a canvas node. `chip` is the small icon in lists and headers.
 * `inline` is a bare icon next to a label, for example an option of a select.
 */
export function NodeIcon({
  name,
  src,
  variant = "chip",
  category,
  className,
}: {
  name: string;
  /** Image URL of the node. It replaces the icon `name`. */
  src?: string;
  category?: string;
  variant?: "tile" | "chip" | "inline";
  className?: string;
}) {
  const Icon = ICONS[name] ?? Circle;
  if (src) {
    return (
      <img
        alt=""
        aria-hidden
        src={src}
        className={cn(
          "shrink-0 object-contain",
          variant === "tile" && "size-6",
          variant === "chip" && "size-6 rounded-md p-0.5",
          variant === "inline" && "size-4 rounded-xs",
          className,
        )}
      />
    );
  }
  if (variant === "inline") {
    return <Icon aria-hidden className={cn("size-4 shrink-0", className)} strokeWidth={1.75} />;
  }
  if (variant === "tile") {
    return (
      <Icon
        aria-hidden
        className={cn("size-6", category && CATEGORY_COLOR[category], className)}
        strokeWidth={1.5}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-current/10",
        category ? CHIP_COLOR[category] : "text-foreground",
        className,
      )}
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
    </span>
  );
}

/** The icon of an option or other labelled item. It renders nothing when the item has no icon. */
export function ItemIconView({ icon }: { icon?: ItemIcon }) {
  if (!icon?.icon && !icon?.iconUrl) return null;
  return <NodeIcon variant="inline" name={icon.icon ?? ""} src={icon.iconUrl} />;
}
