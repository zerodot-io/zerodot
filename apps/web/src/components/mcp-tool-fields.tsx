// SPDX-License-Identifier: AGPL-3.0-only
import {
  Button,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zerodot/ui";
import { useEffect, useRef, useState } from "react";
import type { Json } from "../lib/json";
import { listMcpToolsFn } from "../server/settings-fns";
import { ExpressionInput } from "./expression-input";
import { SchemaForm } from "./schema-form";
import { FieldsEditor } from "./visual-fields";

type Tool = { name: string; description: string; inputSchema: Json };

type Props = {
  projectSlug: string;
  credentialId: string | null;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
};

/**
 * Tool picker and argument form of the MCP Call Tool node. The tools come from the server
 * (the URL and the credential). The argument form comes from the JSON Schema of the tool.
 * The server may be down, so a tool name can also be typed.
 */
export function McpToolFields({ projectSlug, credentialId, config, onChange }: Props) {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = typeof config.url === "string" ? config.url : "";
  const tool = typeof config.tool === "string" ? config.tool : "";
  const args =
    typeof config.arguments === "object" && config.arguments !== null
      ? (config.arguments as Record<string, unknown>)
      : {};
  const selected = tools?.find((t) => t.name === tool);
  const canLoad = url.startsWith("http") && !url.includes("{{");

  const latest = useRef(0);

  async function load() {
    const id = ++latest.current;
    setError(null);
    setLoading(true);
    try {
      const next = (await listMcpToolsFn({ data: { projectSlug, url, credentialId } })) as Tool[];
      if (id === latest.current) setTools(next);
    } catch (caught) {
      if (id === latest.current) {
        setError(caught instanceof Error ? caught.message : "Could not load the tools");
      }
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }

  // Load on open, and again (after a short wait) when the URL or the credential changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load reads these same values
  useEffect(() => {
    if (!canLoad) return;
    const timer = setTimeout(() => void load(), 400);
    return () => clearTimeout(timer);
  }, [canLoad, url, credentialId, projectSlug]);

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor="mcp-tool">tool</FieldLabel>
        <div className="flex gap-2">
          {tools ? (
            <Select
              value={tool}
              items={tools.map((t) => ({ value: t.name, label: t.name }))}
              onValueChange={(value) =>
                value && onChange({ ...config, tool: value, arguments: {} })
              }
            >
              <SelectTrigger id="mcp-tool">
                <SelectValue placeholder="Pick a tool" />
              </SelectTrigger>
              <SelectContent>
                {tools.map((t) => (
                  <SelectItem key={t.name} value={t.name}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <ExpressionInput
              id="mcp-tool"
              value={tool}
              onChange={(next) => onChange({ ...config, tool: next })}
            />
          )}
          <Button variant="outline" disabled={!canLoad || loading} onClick={load}>
            {loading ? "Loading" : "Load tools"}
          </Button>
        </div>
        {selected?.description && (
          <span className="text-muted-foreground">{selected.description}</span>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </Field>
      {selected ? (
        <SchemaForm
          schema={selected.inputSchema}
          value={args}
          onChange={(next) => onChange({ ...config, arguments: next })}
        />
      ) : (
        <Field>
          <FieldLabel>arguments</FieldLabel>
          <FieldsEditor
            value={args}
            onChange={(next) => onChange({ ...config, arguments: next })}
          />
        </Field>
      )}
    </div>
  );
}
