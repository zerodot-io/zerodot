// SPDX-License-Identifier: AGPL-3.0-only

import {
  Alert02Icon,
  ArrowDataTransferHorizontalIcon,
  ArrowUpDownIcon,
  BubbleChatIcon,
  Calendar01Icon,
  Calendar03Icon,
  CheckListIcon,
  CircleIcon,
  ComputerTerminal01Icon,
  CopyXIcon,
  CreditCardIcon,
  Cursor01Icon,
  Database01Icon,
  Delete02Icon,
  File01Icon,
  FileEditIcon,
  FileExportIcon,
  FileImportIcon,
  FileScriptIcon,
  FileSearchIcon,
  FileZipIcon,
  FilterIcon,
  Folder02Icon,
  FolderOpenIcon,
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  Globe02Icon,
  HardDriveIcon,
  Image01Icon,
  Key01Icon,
  ListViewIcon,
  Mail01Icon,
  MailReply01Icon,
  Message01Icon,
  PackageIcon,
  PencilEdit01Icon,
  PlugSocketIcon,
  RefreshIcon,
  RepeatIcon,
  Robot01Icon,
  RssIcon,
  Search01Icon,
  SentIcon,
  SigmaIcon,
  SignpostIcon,
  SourceCodeIcon,
  SparklesIcon,
  StopCircleIcon,
  Table01Icon,
  TableIcon,
  TextIcon,
  TextIndentLessIcon,
  Timer02Icon,
  Video01Icon,
  WebhookIcon,
  WorkflowSquare10Icon,
  Xls01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ItemIcon } from "@zerodot/engine";
import { cn } from "@zerodot/ui";

// Add an icon here when a node uses a new one. Importing the whole set would make the bundle big.
const ICONS: Record<string, IconSvgElement> = {
  Alert02Icon,
  ArrowDataTransferHorizontalIcon,
  ArrowUpDownIcon,
  BubbleChatIcon,
  Calendar01Icon,
  Calendar03Icon,
  CheckListIcon,
  CircleIcon,
  ComputerTerminal01Icon,
  CopyXIcon,
  CreditCardIcon,
  Cursor01Icon,
  Database01Icon,
  Delete02Icon,
  File01Icon,
  FileEditIcon,
  FileExportIcon,
  FileImportIcon,
  FileScriptIcon,
  FileSearchIcon,
  FileZipIcon,
  FilterIcon,
  Folder02Icon,
  FolderOpenIcon,
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  Globe02Icon,
  HardDriveIcon,
  Image01Icon,
  Key01Icon,
  ListViewIcon,
  Mail01Icon,
  MailReply01Icon,
  Message01Icon,
  PackageIcon,
  PencilEdit01Icon,
  PlugSocketIcon,
  RefreshIcon,
  RepeatIcon,
  Robot01Icon,
  RssIcon,
  Search01Icon,
  SentIcon,
  SigmaIcon,
  SignpostIcon,
  SourceCodeIcon,
  SparklesIcon,
  StopCircleIcon,
  Table01Icon,
  TableIcon,
  TextIcon,
  TextIndentLessIcon,
  Timer02Icon,
  Video01Icon,
  WebhookIcon,
  WorkflowSquare10Icon,
  Xls01Icon,
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
  const Icon = ICONS[name] ?? CircleIcon;
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
    return (
      <HugeiconsIcon
        icon={Icon}
        aria-hidden
        className={cn("size-4 shrink-0", className)}
        strokeWidth={1.75}
      />
    );
  }
  if (variant === "tile") {
    return (
      <HugeiconsIcon
        icon={Icon}
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
      <HugeiconsIcon icon={Icon} className="size-3.5" strokeWidth={1.75} />
    </span>
  );
}

/** The icon of an option or other labelled item. It renders nothing when the item has no icon. */
export function ItemIconView({ icon }: { icon?: ItemIcon }) {
  if (!icon?.icon && !icon?.iconUrl) return null;
  return <NodeIcon variant="inline" name={icon.icon ?? ""} src={icon.iconUrl} />;
}
