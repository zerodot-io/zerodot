// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { Editor } from "../components/editor/editor";
import { addServerCatalog } from "../lib/flow";
import { getExtraCatalogFn, getWorkflowFn, listWorkflowsFn } from "../server/fns";
import { listCredentialsFn, listVariablesFn } from "../server/settings-fns";
import { listTablesFn } from "../server/table-fns";

export const Route = createFileRoute("/p/$projectSlug/workflows/$workflowId")({
  loader: async ({ params }) => {
    const [workflow, credentials, variables, tables, extra, workflows] = await Promise.all([
      getWorkflowFn({ data: { projectSlug: params.projectSlug, workflowId: params.workflowId } }),
      listCredentialsFn({ data: { projectSlug: params.projectSlug } }),
      listVariablesFn({ data: { projectSlug: params.projectSlug } }),
      listTablesFn({ data: { projectSlug: params.projectSlug } }),
      getExtraCatalogFn(),
      listWorkflowsFn({ data: { projectSlug: params.projectSlug } }),
    ]);
    addServerCatalog(extra);
    return {
      workflow,
      credentials,
      variables,
      tables,
      extra,
      workflows,
    };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.workflow.name ?? "Workflow"} · zerodot` }],
  }),
  component: EditorPage,
});

function EditorPage() {
  const { workflow, credentials, variables, tables, extra, workflows } = Route.useLoaderData();
  // The loader runs on the server for a full page load. The browser gets the extra nodes here.
  addServerCatalog(extra);
  const { projectSlug } = Route.useParams();
  // Remount on a new workflow so editor state does not leak across workflows.
  return (
    <Editor
      key={workflow.id}
      projectSlug={projectSlug}
      workflow={workflow}
      credentials={credentials}
      tables={tables}
      otherWorkflows={workflows
        .filter((w) => w.id !== workflow.id)
        .map((w) => ({ id: w.id, name: w.name }))}
      variables={variables.map((v) => ({
        key: v.key,
        preview: typeof v.value === "string" ? v.value : JSON.stringify(v.value),
      }))}
    />
  );
}
