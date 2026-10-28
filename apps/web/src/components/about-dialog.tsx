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

const INFO: { label: string; value: string }[] = [
  { label: "Version", value: __APP_VERSION__ },
  { label: "License", value: "AGPL-3.0-only" },
];

/** The product name, the version, and the license. */
export function AboutDialog({ project, onClose }: { project: string; onClose: () => void }) {
  const rows = [...INFO, { label: "Project", value: project }];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Logo className="text-xl" />
          </DialogTitle>
          <DialogDescription>
            Minimal, self-hosted workflow automation. No telemetry.
          </DialogDescription>
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
      </DialogContent>
    </Dialog>
  );
}
