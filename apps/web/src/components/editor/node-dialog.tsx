// SPDX-License-Identifier: AGPL-3.0-only

import {
  ArrowDown01Icon,
  FlashIcon,
  Loading03Icon,
  Login03Icon,
  Logout03Icon,
  PencilEdit02Icon,
  PlayIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ShowRules, toolDescription, visibleCredentialTypes } from "@zerodot/engine";
import { credentialTypeCatalog } from "@zerodot/nodes";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "@zerodot/ui";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { catalogByType, type ZerodotFlowNode } from "../../lib/flow";
import { CredentialDialog, type SavedCredential } from "../credential-dialog";
import { ExpressionInput, FromAIContext } from "../expression-input";
import { McpToolFields } from "../mcp-tool-fields";
import { NodeIcon } from "../node-icon";
import { OutputView } from "../output-view";
import { SchemaForm, type TableHint, type WorkflowHint } from "../schema-form";

export type NodeIO = {
  input?: unknown;
  output?: unknown;
  port?: string | null;
  error?: { message: string; path?: string };
};

type GraphNode = ZerodotFlowNode["data"]["graphNode"];

function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
      {icon}
      <p className="font-medium text-foreground">{title}</p>
      {children}
    </div>
  );
}

/** A wire that points at an empty input handle. */
function NoInputArt() {
  return (
    <svg width="120" height="64" viewBox="0 0 120 64" fill="none" aria-hidden="true">
      <path
        d="M60 8h-6a8 8 0 0 0-8 8v32a8 8 0 0 0 8 8h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.4"
      />
      <circle cx="46" cy="32" r="5" fill="currentColor" opacity="0.7" />
      <path
        d="M4 34l26-3m0 0-6-4m6 4-5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.4"
      />
    </svg>
  );
}

function Pane({
  title,
  className,
  style,
  children,
}: {
  title: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex min-h-0 flex-col gap-3 p-4", className)} style={style}>
      <h3 className="font-medium text-muted-foreground uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}

const MIN_PANE = 220;

/** A drag handle between two panes. It reports the drag distance in pixels. */
function ResizeHandle({ label, onDrag }: { label: string; onDrag: (deltaX: number) => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a drag handle, not a thematic break
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className="group relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-border"
      onPointerDown={(event) => {
        event.preventDefault();
        let lastX = event.clientX;
        const move = (e: PointerEvent) => {
          onDrag(e.clientX - lastX);
          lastX = e.clientX;
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.userSelect = "";
        };
        document.body.style.userSelect = "none";
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    >
      <span className="absolute inset-y-0 -left-1.5 w-3 transition-colors group-hover:bg-primary/20 group-active:bg-primary/30" />
    </div>
  );
}

function MockEditor({
  onSave,
  onCancel,
}: {
  onSave: (data: unknown) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("{\n  \n}");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Textarea
        aria-label="Mock data (JSON)"
        value={text}
        spellCheck={false}
        className="min-h-0 flex-1 font-mono"
        onChange={(event) => setText(event.target.value)}
      />
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          onClick={() => {
            try {
              onSave(JSON.parse(text));
            } catch {
              setError("This is not valid JSON");
            }
          }}
        >
          Pin mock data
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

function Settings({
  node,
  onChange,
}: {
  node: GraphNode;
  onChange: (update: (n: GraphNode) => GraphNode) => void;
}) {
  const retry = node.retry;
  return (
    <div className="flex flex-col gap-4">
      <ToggleRow
        id="always-output"
        label="Always output data"
        checked={node.alwaysOutputData === true}
        onChange={(alwaysOutputData) => onChange((n) => ({ ...n, alwaysOutputData }))}
      />
      <ToggleRow
        id="execute-once"
        label="Execute once"
        checked={node.executeOnce === true}
        onChange={(executeOnce) => onChange((n) => ({ ...n, executeOnce }))}
      />
      <ToggleRow
        id="retry-on-fail"
        label="Retry on fail"
        checked={retry !== undefined}
        onChange={(on) =>
          onChange((n) => ({ ...n, retry: on ? { max: 3, backoffMs: 1000 } : undefined }))
        }
      />
      {retry && (
        <>
          <Field>
            <FieldLabel htmlFor="retry-max">Max tries</FieldLabel>
            <Input
              id="retry-max"
              inputMode="numeric"
              value={String(retry.max)}
              onChange={(event) => {
                const max = Math.min(10, Math.max(1, Math.floor(Number(event.target.value) || 1)));
                onChange((n) => (n.retry ? { ...n, retry: { ...n.retry, max } } : n));
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="retry-backoff">Wait between tries (ms)</FieldLabel>
            <Input
              id="retry-backoff"
              inputMode="numeric"
              value={String(retry.backoffMs)}
              onChange={(event) => {
                const backoffMs = Math.min(
                  60_000,
                  Math.max(0, Math.floor(Number(event.target.value) || 0)),
                );
                onChange((n) => (n.retry ? { ...n, retry: { ...n.retry, backoffMs } } : n));
              }}
            />
          </Field>
        </>
      )}
      <Field>
        <FieldLabel htmlFor="on-error">On error</FieldLabel>
        <Select
          value={node.onError}
          items={[
            { value: "fail", label: "Stop the run" },
            { value: "continue", label: "Continue with the error as output" },
          ]}
          onValueChange={(value) =>
            onChange((n) => ({ ...n, onError: value === "continue" ? "continue" : "fail" }))
          }
        >
          <SelectTrigger id="on-error">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fail">Stop the run</SelectItem>
            <SelectItem value="continue">Continue with the error as output</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="node-notes">Notes</FieldLabel>
        <Textarea
          id="node-notes"
          rows={5}
          value={node.notes ?? ""}
          onChange={(event) => onChange((n) => ({ ...n, notes: event.target.value }))}
        />
      </Field>
      <ToggleRow
        id="notes-in-flow"
        label="Display note in flow"
        checked={node.notesInFlow === true}
        onChange={(notesInFlow) => onChange((n) => ({ ...n, notesInFlow }))}
      />
    </div>
  );
}

/** The two URLs of a webhook trigger. Same token. The test URL needs no publish. */
function WebhookUrls({
  testUrl,
  productionUrl,
  method,
}: {
  testUrl: string;
  productionUrl: string | null;
  method: string;
}) {
  const [open, setOpen] = useState(true);
  const [which, setWhich] = useState<"test" | "production">("test");
  // The URL ends the same before and after a publish: the path, or the token.
  const url = which === "test" ? testUrl : testUrl.replace("/hooks-test/", "/hooks/");
  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 font-medium text-primary"
      >
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn("size-4 transition-transform", !open && "-rotate-90")}
        />
        Webhook URLs
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-b pb-4 pl-6">
          <div className="flex w-fit gap-0.5 rounded-md bg-muted p-0.5" role="tablist">
            {(["test", "production"] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={which === name}
                onClick={() => setWhich(name)}
                className={cn(
                  "rounded px-3 py-1 transition-colors duration-150",
                  which === name ? "bg-card font-medium shadow-xs" : "text-muted-foreground",
                )}
              >
                {name === "test" ? "Test URL" : "Production URL"}
              </button>
            ))}
          </div>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded bg-muted px-1.5 font-medium text-muted-foreground text-xs">
              {method}
            </span>
            <code className="break-all text-xs">{url}</code>
          </div>
          {which === "production" && productionUrl !== url && (
            <p className="text-muted-foreground">
              Live after you publish and turn on Active. A new path needs a publish.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

const NO_CREDENTIAL = "__none";
const NEW_CREDENTIAL = "__new";

/** The MCP node has its own tool picker and argument form. */
const MCP_NODE = "mcp.call_tool";

function withoutProperties(schema: unknown, keys: string[]): unknown {
  const { properties = {}, ...rest } = schema as { properties?: Record<string, unknown> };
  return {
    ...rest,
    properties: Object.fromEntries(Object.entries(properties).filter(([k]) => !keys.includes(k))),
  };
}

function CredentialPicker({
  projectSlug,
  node,
  allowedTypes,
  credentials,
  onChange,
  onCreated,
  label,
}: {
  label: string;
  projectSlug: string;
  node: GraphNode;
  allowedTypes: string[];
  credentials: SavedCredential[];
  onChange: (update: (n: GraphNode) => GraphNode) => void;
  onCreated: (credential: SavedCredential) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const usable = credentials.filter((c) => allowedTypes.includes(c.type));
  const iconOf = (type: string) => {
    const entry = credentialTypeCatalog.find((t) => t.type === type);
    return <NodeIcon name={entry?.icon ?? "Key01Icon"} src={entry?.iconUrl} />;
  };
  const typeLabel = (type: string) => credentialTypeCatalog.find((t) => t.type === type)?.label;
  const selected = usable.find((c) => c.id === node.credentialId);
  const dynamic = node.credentialExpression !== undefined;
  return (
    <Field>
      <div className="flex items-center justify-between">
        <FieldLabel htmlFor="node-credential">{label}</FieldLabel>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange((n) => ({
              ...n,
              credentialExpression: dynamic ? undefined : "{{ $input.account }}",
            }))
          }
        >
          {dynamic ? "Fixed" : "Expression"}
        </Button>
      </div>
      {dynamic ? (
        <>
          <ExpressionInput
            id="node-credential"
            value={node.credentialExpression ?? ""}
            onChange={(value) => onChange((n) => ({ ...n, credentialExpression: value }))}
          />
          <FieldDescription>
            Gives the name or the id of a credential when the node runs. Replaces the fixed
            credential.
          </FieldDescription>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <Select
            value={node.credentialId ?? NO_CREDENTIAL}
            items={[
              { value: NO_CREDENTIAL, label: "None" },
              ...usable.map((c) => ({ value: c.id, label: c.name })),
            ]}
            onValueChange={(value) => {
              if (value === NEW_CREDENTIAL) {
                setCreating(true);
                return;
              }
              onChange((n) => ({ ...n, credentialId: value === NO_CREDENTIAL ? null : value }));
            }}
          >
            <SelectTrigger id="node-credential" className="w-full flex-1">
              {selected && iconOf(selected.type)}
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CREDENTIAL}>None</SelectItem>
              {usable.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {iconOf(c.type)}
                  {c.name}
                  <span className="ml-2 text-muted-foreground">{typeLabel(c.type)}</span>
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value={NEW_CREDENTIAL}>
                <HugeiconsIcon icon={PlusSignIcon} />
                Create new credential
              </SelectItem>
            </SelectContent>
          </Select>
          {selected && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Edit credential"
              onClick={() => setEditing(true)}
            >
              <HugeiconsIcon icon={PencilEdit02Icon} />
            </Button>
          )}
        </div>
      )}
      {(creating || (editing && selected)) && (
        <CredentialDialog
          key={creating ? "new" : selected?.id}
          projectSlug={projectSlug}
          open
          existing={creating ? undefined : selected}
          allowedTypes={allowedTypes}
          onOpenChange={(open) => {
            if (open) return;
            setCreating(false);
            setEditing(false);
          }}
          onSaved={(saved) => {
            onCreated(saved);
            onChange((n) => ({ ...n, credentialId: saved.id }));
          }}
        />
      )}
    </Field>
  );
}

type Props = {
  tables: TableHint[];
  /** Other workflows of the project, for the Execute Workflow node. */
  workflows: WorkflowHint[];
  /** The time zone of the workflow. A Schedule node without its own time zone uses it. */
  defaultTimezone: string;
  projectSlug: string;
  credentials: SavedCredential[];
  onCredentialCreated: (credential: SavedCredential) => void;
  node: ZerodotFlowNode | null;
  /** True when an edge leads into the node. */
  hasInput: boolean;
  /** The node is on a tool port: it runs as a tool, not as a step. */
  asTool?: boolean;
  /** For a node that joins several inputs (Merge): each input port and whether an edge leads into it. */
  inputPorts: { port: string; connected: boolean }[] | null;
  io: NodeIO | undefined;
  webhookUrl: string | null;
  /** The URL for test events. It works before a publish. */
  testUrl: string | null;
  /** True while the editor waits for a request on the test URL. */
  listening: boolean;
  onListen: () => void;
  onStopListen: () => void;
  onClose: () => void;
  onChange: (update: (node: GraphNode) => GraphNode) => void;
  /** Run this node alone with its last known input. The dialog stays open. */
  onExecuteStep: () => void;
  /** True while a run that the dialog started is going. */
  busy: boolean;
};

/** Opens on double click: input, parameters and settings, output. */
export function NodeDialog({
  tables,
  workflows,
  defaultTimezone,
  projectSlug,
  credentials,
  onCredentialCreated,
  node,
  hasInput,
  asTool = false,
  inputPorts,
  io,
  webhookUrl,
  testUrl,
  listening,
  onListen,
  onStopListen,
  onClose,
  onChange,
  onExecuteStep,
  busy,
}: Props) {
  const graphNode = node?.data.graphNode;
  const entry = graphNode ? catalogByType.get(graphNode.type) : undefined;
  const [tab, setTab] = useState<"parameters" | "settings">("parameters");
  const [mocking, setMocking] = useState(false);
  const [inputWidth, setInputWidth] = useState(320);
  const [paramsWidth, setParamsWidth] = useState(440);
  const panesRef = useRef<HTMLDivElement>(null);

  // Keep the output pane at least MIN_PANE wide.
  const resize = (set: (fn: (w: number) => number) => void, other: number, delta: number) => {
    const total = panesRef.current?.clientWidth ?? Number.POSITIVE_INFINITY;
    set((w) => Math.min(total - other - MIN_PANE, Math.max(MIN_PANE, w + delta)));
  };

  const close = () => {
    setTab("parameters");
    setMocking(false);
    onClose();
  };

  const isTrigger = entry?.category === "trigger";
  // A supply node is no step: it has no input, no output, and does not run alone.
  const isSupply = entry?.supplies !== undefined || asTool;
  const isWebhookNode = graphNode?.type === "trigger.webhook";
  // A service calls the test URL of some triggers, not a person. The URL is not for them.
  const serviceHint = entry?.webhookTest?.hint;
  // Each node says which credential types apply for its current config.
  const credentialTypes =
    graphNode && entry
      ? visibleCredentialTypes(
          entry.credentialTypes,
          entry.credentialRules as Record<string, ShowRules>,
          (key) => graphNode.config[key],
        )
      : [];
  const picker =
    graphNode && entry ? (
      <CredentialPicker
        label="Credential"
        projectSlug={projectSlug}
        node={graphNode}
        allowedTypes={credentialTypes}
        credentials={credentials}
        onChange={onChange}
        onCreated={onCredentialCreated}
      />
    ) : null;
  const pinned = graphNode?.pinned ?? null;
  const output = io?.output !== undefined ? io.output : pinned?.data;

  return (
    <Dialog open={node !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex h-[min(60rem,90svh)] w-[min(112rem,92vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        {graphNode && (
          <>
            <DialogHeader className="border-b px-4 py-2 pr-12">
              <DialogTitle className="flex items-center gap-2">
                <NodeIcon
                  name={entry?.icon ?? "CircleIcon"}
                  src={entry?.iconUrl}
                  category={entry?.category}
                />
                <Input
                  aria-label="Node name"
                  value={graphNode.name}
                  className="h-6 w-72 border-transparent bg-transparent font-semibold shadow-none"
                  onChange={(event) => onChange((n) => ({ ...n, name: event.target.value }))}
                />
                {!isSupply && (
                  <Button size="xs" className="ml-auto" disabled={busy} onClick={onExecuteStep}>
                    {busy ? (
                      <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                    ) : (
                      <HugeiconsIcon icon={PlayIcon} />
                    )}
                    {busy ? "Running…" : "Execute step"}
                  </Button>
                )}
              </DialogTitle>
            </DialogHeader>
            <div ref={panesRef} className="flex min-h-0 min-w-0 flex-1">
              <Pane
                title={isTrigger ? "Trigger" : "Input"}
                className="shrink-0 bg-muted/40"
                style={{ width: inputWidth }}
              >
                {isTrigger ? (
                  listening ? (
                    <EmptyState
                      icon={
                        <HugeiconsIcon
                          icon={FlashIcon}
                          className="size-5 animate-pulse text-primary"
                        />
                      }
                      title="Listening for test event"
                    >
                      {serviceHint && <p>{serviceHint}</p>}
                      {testUrl && !serviceHint && (
                        <>
                          <p>Send a request to:</p>
                          <code className="max-w-full break-all rounded-md bg-card p-2 text-xs">
                            {testUrl}
                          </code>
                        </>
                      )}
                      <Button variant="outline" onClick={onStopListen}>
                        Stop listening
                      </Button>
                    </EmptyState>
                  ) : (
                    <EmptyState
                      icon={<HugeiconsIcon icon={FlashIcon} className="size-5" />}
                      title={`Pull in events from ${entry?.label}`}
                    >
                      <Button disabled={busy || !testUrl} onClick={onListen}>
                        Listen for test event
                      </Button>
                      <p className="max-w-xs">
                        {serviceHint
                          ? `${serviceHint}. The workflow does not need a publish.`
                          : "Send one request to the test URL. The workflow does not need a publish."}
                      </p>
                    </EmptyState>
                  )
                ) : inputPorts && inputPorts.length > 1 ? (
                  <div className="flex flex-col gap-4 p-3" data-testid="join-inputs">
                    {inputPorts.map(({ port, connected }, index) => {
                      const value =
                        io?.input !== null && typeof io?.input === "object"
                          ? (io.input as Record<string, unknown>)[port]
                          : undefined;
                      return (
                        <section key={port} className="flex flex-col gap-1.5">
                          <h3 className="font-medium">Input {index + 1}</h3>
                          {!connected ? (
                            <p className="text-muted-foreground">Not connected</p>
                          ) : value === undefined ? (
                            <p className="text-muted-foreground">
                              {io?.input === undefined ? "Run a test to see the input" : "No data"}
                            </p>
                          ) : (
                            <OutputView value={value} />
                          )}
                        </section>
                      );
                    })}
                  </div>
                ) : !hasInput && !isSupply ? (
                  <EmptyState icon={<NoInputArt />} title="No input connected" />
                ) : io?.input === undefined && isSupply ? (
                  <EmptyState
                    icon={<HugeiconsIcon icon={Logout03Icon} className="size-5" />}
                    title="No calls yet"
                  >
                    <p>Run the workflow. The last call from the node it supplies shows here.</p>
                  </EmptyState>
                ) : io?.input === undefined ? (
                  <EmptyState
                    icon={<HugeiconsIcon icon={Logout03Icon} className="size-5" />}
                    title="No input data"
                  >
                    <p>Run a test to see the input.</p>
                  </EmptyState>
                ) : (
                  <OutputView value={io.input} dragRoot="$input" />
                )}
              </Pane>

              <ResizeHandle
                label="Resize input pane"
                onDrag={(d) => resize(setInputWidth, paramsWidth, d)}
              />

              <section className="flex min-h-0 shrink-0 flex-col" style={{ width: paramsWidth }}>
                <div className="flex items-center gap-4 border-b px-4" role="tablist">
                  {(["parameters", "settings"] as const).map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="tab"
                      aria-selected={tab === name}
                      onClick={() => setTab(name)}
                      className={cn(
                        "-mb-px border-b-2 py-2 capitalize transition-colors duration-150",
                        tab === name
                          ? "border-primary font-medium text-primary"
                          : "border-transparent text-muted-foreground",
                      )}
                    >
                      {name}
                    </button>
                  ))}
                  {isTrigger && testUrl && (
                    <Button
                      size="sm"
                      variant={listening ? "outline" : "default"}
                      className="my-1.5 ml-auto"
                      disabled={busy}
                      onClick={listening ? onStopListen : onListen}
                    >
                      {listening ? "Stop listening" : "Listen for test event"}
                    </Button>
                  )}
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
                  {tab === "parameters" ? (
                    <>
                      {testUrl && !serviceHint && (
                        <WebhookUrls
                          testUrl={testUrl}
                          productionUrl={webhookUrl}
                          method={
                            typeof graphNode.config.httpMethod === "string"
                              ? graphNode.config.httpMethod
                              : "POST"
                          }
                        />
                      )}
                      {asTool && (
                        <Field>
                          <FieldLabel htmlFor="tool-description">Tool description</FieldLabel>
                          <Textarea
                            id="tool-description"
                            rows={2}
                            placeholder={
                              entry
                                ? toolDescription({ config: graphNode.config }, entry)
                                : "What the tool does, for the model"
                            }
                            value={graphNode.toolDescription ?? ""}
                            onChange={(event) =>
                              onChange((n) => ({
                                ...n,
                                toolDescription: event.target.value || undefined,
                              }))
                            }
                          />
                        </Field>
                      )}
                      {entry && !isWebhookNode && credentialTypes.length > 0 && picker}
                      {entry && (
                        <FromAIContext.Provider value={asTool}>
                          <SchemaForm
                            tables={tables}
                            workflows={workflows}
                            defaultTimezone={defaultTimezone}
                            after={
                              isWebhookNode && credentialTypes.length > 0
                                ? { authentication: picker }
                                : undefined
                            }
                            schema={
                              graphNode.type === MCP_NODE
                                ? withoutProperties(entry.configSchema, ["tool", "arguments"])
                                : entry.configSchema
                            }
                            value={graphNode.config}
                            onChange={(config) => onChange((n) => ({ ...n, config }))}
                          />
                        </FromAIContext.Provider>
                      )}
                      {graphNode.type === MCP_NODE && (
                        <McpToolFields
                          projectSlug={projectSlug}
                          credentialId={graphNode.credentialId}
                          config={graphNode.config}
                          onChange={(config) => onChange((n) => ({ ...n, config }))}
                        />
                      )}
                    </>
                  ) : (
                    <Settings node={graphNode} onChange={onChange} />
                  )}
                </div>
              </section>

              <ResizeHandle
                label="Resize parameters pane"
                onDrag={(d) => resize(setParamsWidth, inputWidth, d)}
              />

              <Pane title="Output" className="min-w-0 flex-1 bg-muted/40">
                {mocking ? (
                  <MockEditor
                    onCancel={() => setMocking(false)}
                    onSave={(data) => {
                      onChange((n) => ({ ...n, pinned: { port: "out", data } }));
                      setMocking(false);
                    }}
                  />
                ) : output === undefined && isSupply ? (
                  <EmptyState
                    icon={<HugeiconsIcon icon={Login03Icon} className="size-5" />}
                    title="No calls yet"
                  />
                ) : output === undefined ? (
                  <EmptyState
                    icon={<HugeiconsIcon icon={Login03Icon} className="size-5" />}
                    title="No output data"
                  >
                    <p>
                      Run a test, or{" "}
                      <button
                        type="button"
                        className="font-medium text-foreground underline underline-offset-2"
                        onClick={() => setMocking(true)}
                      >
                        set mock data
                      </button>
                      .
                    </p>
                  </EmptyState>
                ) : (
                  <>
                    {pinned && (
                      <span className="text-muted-foreground">
                        Pinned. Test runs skip this node.
                      </span>
                    )}
                    <OutputView
                      value={output}
                      actions={
                        // A supply node is no step, so its data cannot be pinned.
                        isSupply ? undefined : (
                          <Button
                            variant={pinned ? "default" : "outline"}
                            size="xs"
                            onClick={() =>
                              onChange((n) => ({
                                ...n,
                                pinned: pinned ? null : { port: io?.port ?? "out", data: output },
                              }))
                            }
                          >
                            {pinned ? "Unpin" : "Pin"}
                          </Button>
                        )
                      }
                    />
                  </>
                )}
                {io?.error && (
                  <p role="alert" className="text-destructive">
                    {io.error.message}
                    {io.error.path ? ` (at ${io.error.path})` : ""}
                  </p>
                )}
              </Pane>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
