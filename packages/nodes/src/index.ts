// SPDX-License-Identifier: AGPL-3.0-only
import { createRegistry, type Graph, type NodeDefinition, type ShowRules } from "@zerodot/engine";
import { z } from "zod";
import codeJs from "./code-js";
import coreExecuteCommand from "./core-execute-command";
import dataAggregate from "./data-aggregate";
import dataCrypto from "./data-crypto";
import dataDateTime from "./data-date-time";
import dataFilter from "./data-filter";
import dataHtmlExtract from "./data-html-extract";
import dataLimit from "./data-limit";
import dataMerge from "./data-merge";
import dataRemoveDuplicates from "./data-remove-duplicates";
import dataRenameKeys from "./data-rename-keys";
import dataReplaceText from "./data-replace-text";
import dataSet from "./data-set";
import dataSort from "./data-sort";
import dataSummarize from "./data-summarize";
import dataXml from "./data-xml";
import fileCompress from "./file-compress";
import fileConvertTo from "./file-convert-to";
import fileDisk from "./file-disk";
import fileExtractFrom from "./file-extract-from";
import flowDelay from "./flow-delay";
import flowExecuteWorkflow from "./flow-execute-workflow";
import flowLoop from "./flow-loop";
import flowNoop from "./flow-noop";
import flowRespond from "./flow-respond";
import flowStopError from "./flow-stop-error";
import httpRequest from "./http-request";
import logicIf from "./logic-if";
import logicSwitch from "./logic-switch";
import rssRead from "./rss-read";
import tableDelete from "./table-delete";
import tableGet from "./table-get";
import tableGetAll from "./table-get-all";
import tableInsert from "./table-insert";
import tableQuery from "./table-query";
import tableUpdate from "./table-update";
import tableUpsert from "./table-upsert";
import triggerCron from "./trigger-cron";
import triggerError from "./trigger-error";
import triggerHttpPoll from "./trigger-http-poll";
import triggerManual from "./trigger-manual";
import triggerWebhook from "./trigger-webhook";
import { checkGraphNodes } from "./validate-graph";

export { originAllowed } from "./webhook-checks";

export const nodes: NodeDefinition[] = [
  triggerWebhook,
  triggerCron,
  triggerManual,
  triggerError,
  triggerHttpPoll,
  httpRequest,
  logicIf,
  logicSwitch,
  dataSet,
  dataAggregate,
  dataCrypto,
  dataDateTime,
  dataMerge,
  dataFilter,
  dataLimit,
  dataRemoveDuplicates,
  dataRenameKeys,
  dataReplaceText,
  dataSort,
  dataSummarize,
  dataHtmlExtract,
  dataXml,
  fileConvertTo,
  fileExtractFrom,
  fileCompress,
  fileDisk,
  rssRead,
  flowDelay,
  flowExecuteWorkflow,
  flowLoop,
  flowNoop,
  flowRespond,
  flowStopError,
  codeJs,
  coreExecuteCommand,
  tableInsert,
  tableQuery,
  tableGet,
  tableGetAll,
  tableUpdate,
  tableUpsert,
  tableDelete,
];

export * from "./credentials";
export { validateCron } from "./cron";
export { credentialHeader } from "./credential-header";
export * from "./oauth2";
export * from "./open-credential";
export { type WaitCallbackData, waitCallbackData } from "./wait-callback";
export { messagePage, parseWaitForm, renderWaitForm } from "./wait-form";

export const registry = createRegistry(nodes);

/** Problems in the node types, configs, and edge ports of a graph. Empty when it is fine. */
export const validateGraphNodes = (graph: Graph): string[] => checkGraphNodes(graph, registry);

export type NodeCatalogEntry = {
  type: string;
  label: string;
  description?: string;
  category: string;
  app?: string;
  actions?: { label: string; config: Record<string, unknown> }[];
  icon: string;
  iconUrl?: string;
  ports: { in: string[]; out: string[] };
  defaultConfig: unknown;
  credentialTypes: string[];
  /** A trigger that registers its test address at a service. The hint replaces the address in the editor. */
  webhookTest?: { hint: string };
  /** When each credential type applies, by config value. */
  credentialRules: Record<string, ShowRules>;
  /** JSON Schema of the config. The editor builds its form from it. */
  configSchema: unknown;
};

const catalogEntry = (node: NodeDefinition): NodeCatalogEntry => ({
  type: node.type,
  label: node.label,
  description: node.description,
  category: node.category,
  app: node.app,
  actions: node.actions,
  icon: node.icon,
  iconUrl: node.iconUrl,
  webhookTest: node.webhookTest,
  ports: node.ports,
  defaultConfig: node.defaultConfig,
  credentialTypes: node.credentialTypes ?? [],
  credentialRules: node.credentialRules ?? {},
  configSchema: z.toJSONSchema(node.config, { io: "input", unrepresentable: "any" }),
});

/** Plain data about the nodes. Safe to send to the browser. */
export const catalog: NodeCatalogEntry[] = nodes.map(catalogEntry);

/** The entries that `registerNodes` added. The browser does not have them in its bundle. */
export const addedCatalog: NodeCatalogEntry[] = [];

/** The browser calls this with the entries that the server added. A known type is skipped. */
export function mergeCatalog(entries: NodeCatalogEntry[]): void {
  for (const entry of entries) {
    if (!catalog.some((known) => known.type === entry.type)) catalog.push(entry);
  }
}

/**
 * Adds nodes at run time, for example the nodes of an installed package. A type that exists
 * already is skipped. Returns the types that were added.
 */
export function registerNodes(definitions: NodeDefinition[]): string[] {
  const added: string[] = [];
  for (const definition of definitions) {
    if (registry.has(definition.type)) continue;
    (registry as Map<string, NodeDefinition>).set(definition.type, definition);
    nodes.push(definition);
    const entry = catalogEntry(definition);
    catalog.push(entry);
    addedCatalog.push(entry);
    added.push(definition.type);
  }
  return added;
}

/** Removes nodes that `registerNodes` added, for example when a package is uninstalled. */
export function unregisterNodes(types: string[]): void {
  for (const type of types) {
    (registry as Map<string, NodeDefinition>).delete(type);
    for (const list of [nodes, catalog, addedCatalog] as { type: string }[][]) {
      const at = list.findIndex((entry) => entry.type === type);
      if (at >= 0) list.splice(at, 1);
    }
  }
}
export * from "./credential-test";
