// SPDX-License-Identifier: AGPL-3.0-only
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
  Logo,
} from "@zerodot/ui";

/** The page of a release on GitHub. */
export const releaseUrl = (version: string) =>
  `https://github.com/zerodot-io/zerodot/releases/tag/v${version}`;

const INFO: { label: string; value: string }[] = [
  { label: "Version", value: __APP_VERSION__ },
  { label: "License", value: "AGPL-3.0-only" },
];

/** The product name, the version, and the license. */
export function AboutDialog({
  project,
  update,
  onClose,
}: {
  project: string;
  /** The newest version, when it is newer than this one. */
  update?: string | null;
  onClose: () => void;
}) {
  const rows = [...INFO, { label: "Project", value: project }];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Logo className="text-xl" />
          </DialogTitle>
          <DialogDescription>Minimal, self-hosted workflow automation.</DialogDescription>
        </DialogHeader>
        <ItemGroup>
          {rows.map((row, i) => (
            <div key={row.label}>
              {i > 0 && <ItemSeparator />}
              <Item size="xs">
                <ItemContent>
                  <ItemDescription>{row.label}</ItemDescription>
                </ItemContent>
                <ItemTitle className="tabular-nums">{row.value}</ItemTitle>
              </Item>
            </div>
          ))}
        </ItemGroup>
        {update && (
          <a
            href={releaseUrl(update)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium underline underline-offset-4"
          >
            Update available: v{update}
          </a>
        )}
      </DialogContent>
    </Dialog>
  );
}
