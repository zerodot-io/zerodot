// SPDX-License-Identifier: AGPL-3.0-only
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@zerodot/ui";
import type { ColumnJson } from "../server/table-fns";

export const COLUMN_TYPES: ColumnJson["type"][] = ["string", "number", "boolean", "date", "json"];

export type ColumnDraft = {
  key: string;
  type: ColumnJson["type"];
  required: boolean;
  unique: boolean;
};

export const emptyColumn = (): ColumnDraft => ({
  key: "",
  type: "string",
  required: false,
  unique: false,
});

/** One line to define a column: key, type, required, unique. */
export function ColumnFields({
  value,
  onChange,
  onRemove,
}: {
  value: ColumnDraft;
  onChange: (next: ColumnDraft) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="Column key"
        className="min-w-0 flex-1 font-mono"
        placeholder="email"
        value={value.key}
        onChange={(event) => onChange({ ...value, key: event.target.value })}
      />
      <Select
        value={value.type}
        onValueChange={(type) => type && onChange({ ...value, type: type as ColumnDraft["type"] })}
      >
        <SelectTrigger aria-label="Column type" className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {COLUMN_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {type}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-1 text-muted-foreground">
        <Switch
          aria-label="Required"
          checked={value.required}
          onCheckedChange={(required) => onChange({ ...value, required })}
        />
        Required
      </div>
      <div className="flex items-center gap-1 text-muted-foreground">
        <Switch
          aria-label="Unique"
          checked={value.unique}
          disabled={value.type === "json"}
          onCheckedChange={(unique) => onChange({ ...value, unique })}
        />
        Unique
      </div>
      {onRemove && (
        <Button type="button" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  );
}
