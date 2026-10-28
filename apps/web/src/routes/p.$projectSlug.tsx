// SPDX-License-Identifier: AGPL-3.0-only

import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { authClient } from "@zerodot/auth/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PROJECT_LABEL,
} from "@zerodot/ui";
import {
  Activity,
  ArrowLeft,
  CircleUser,
  Database,
  KeyRound,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Settings,
  SquareFunction,
  Variable,
  Workflow,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ProjectDialog } from "../components/project-dialog";
import { createWorkflowFn, getIsInstanceAdmin, getProjectFn, listWorkflowsFn } from "../server/fns";

export const Route = createFileRoute("/p/$projectSlug")({
  beforeLoad: async ({ params }) => {
    const ctx = await getProjectFn({ data: { projectSlug: params.projectSlug } });
    if (!ctx) throw redirect({ to: "/sign-in" });
    return ctx;
  },
  component: ProjectLayout,
});

type NavTo =
  | "/p/$projectSlug/workflows"
  | "/p/$projectSlug/runs"
  | "/p/$projectSlug/insights"
  | "/p/$projectSlug/credentials"
  | "/p/$projectSlug/variables"
  | "/p/$projectSlug/tables"
  | "/p/$projectSlug/api-keys"
  | "/p/$projectSlug/settings";

const navItems: { to: NavTo; label: string; icon: LucideIcon }[] = [
  { to: "/p/$projectSlug/workflows", label: "Workflows", icon: Workflow },
  { to: "/p/$projectSlug/runs", label: "Runs", icon: Play },
  { to: "/p/$projectSlug/insights", label: "Insights", icon: Activity },
  { to: "/p/$projectSlug/credentials", label: "Credentials", icon: KeyRound },
  { to: "/p/$projectSlug/variables", label: "Variables", icon: Variable },
  { to: "/p/$projectSlug/tables", label: "Data tables", icon: Database },
  { to: "/p/$projectSlug/api-keys", label: "API keys", icon: SquareFunction },
  { to: "/p/$projectSlug/settings", label: "Settings", icon: Settings },
];

const railItem =
  "group relative flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground";
// Label shows on hover or keyboard focus, to the right of the rail.
const railLabel =
  "pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-foreground opacity-0 shadow-md group-hover:opacity-100 group-focus-visible:opacity-100";

const HIDDEN_KEY = "zerodot:sidebar-hidden";

type WorkflowItem = { id: string; name: string; active: boolean };

function ProjectLayout() {
  const { user, project, projects } = Route.useRouteContext();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [hidden, setHiddenState] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [instanceAdmin, setInstanceAdmin] = useState(false);
  const dock = useRef<HTMLDivElement>(null);
  const slug = project.slug;

  // Once per layout mount. The layout stays mounted while you move between pages.
  useEffect(() => {
    getIsInstanceAdmin()
      .then(setInstanceAdmin)
      .catch(() => setInstanceAdmin(false));
  }, []);

  useEffect(() => {
    try {
      setHiddenState(localStorage.getItem(HIDDEN_KEY) === "1");
    } catch {
      // storage blocked: keep default
    }
  }, []);

  function setHidden(value: boolean) {
    setAnimate(true);
    setHiddenState(value);
    try {
      localStorage.setItem(HIDDEN_KEY, value ? "1" : "0");
    } catch {
      // storage blocked: state lasts for this page load only
    }
  }

  useEffect(() => {
    if (!open) return;
    let stale = false;
    listWorkflowsFn({ data: { projectSlug: slug } }).then((rows) => {
      if (!stale) setWorkflows(rows);
    });
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !dock.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      stale = true;
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, slug]);

  async function createWorkflow() {
    const created = await createWorkflowFn({ data: { projectSlug: slug, name: "Untitled" } });
    setOpen(false);
    await navigate({
      to: "/p/$projectSlug/workflows/$workflowId",
      params: { projectSlug: slug, workflowId: created.id },
    });
  }
  // The canvas goes edge to edge. The rail floats over it. Other pages leave room for it.
  const onCanvas = useMatchRoute()({ to: "/p/$projectSlug/workflows/$workflowId" });
  return (
    <div className={onCanvas || hidden ? "min-h-svh" : "min-h-svh pl-16"}>
      <button
        type="button"
        aria-label="Show sidebar"
        inert={!hidden}
        onClick={() => setHidden(false)}
        className={`fixed top-1/2 left-3 z-20 flex size-9 -translate-y-1/2 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-md hover:text-foreground motion-reduce:transition-none ${animate ? "transition-opacity duration-150 ease-out" : ""} ${hidden ? "opacity-100" : "opacity-0"}`}
      >
        <PanelLeftOpen className="size-4" />
      </button>
      <div
        ref={dock}
        inert={hidden}
        className={`fixed top-1/2 left-3 z-20 flex -translate-y-1/2 items-stretch rounded-xl border bg-card shadow-md motion-reduce:transition-none ${animate ? "transition-[translate,opacity] duration-150 ease-out" : ""} ${hidden ? "pointer-events-none -translate-x-2 opacity-0" : ""}`}
      >
        <nav aria-label="Project" className="flex flex-col items-center gap-1 p-1.5">
          {navItems.map(({ to, label, icon: Icon }) =>
            to === "/p/$projectSlug/workflows" ? (
              <button
                key={to}
                type="button"
                aria-label={label}
                aria-expanded={open}
                aria-controls="workflow-panel"
                onClick={() => setOpen((v) => !v)}
                className={open ? `${railItem} bg-muted text-foreground` : railItem}
              >
                <Icon className="size-4" />
                {!open && <span className={railLabel}>{label}</span>}
              </button>
            ) : (
              <Link
                key={to}
                to={to}
                params={{ projectSlug: slug }}
                aria-label={label}
                className={railItem}
                activeProps={{ className: `${railItem} bg-muted text-foreground` }}
              >
                <Icon className="size-4" />
                <span className={railLabel}>{label}</span>
              </Link>
            ),
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Account"
              className={`${railItem} mt-1 border-t pt-0.5`}
            >
              <CircleUser className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="capitalize">{PROJECT_LABEL}s</DropdownMenuLabel>
                {projects.map((p) => (
                  <DropdownMenuItem
                    key={p.slug}
                    onClick={() =>
                      navigate({ to: "/p/$projectSlug/workflows", params: { projectSlug: p.slug } })
                    }
                  >
                    {p.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onClick={() => setNewProject(true)}>
                  New {PROJECT_LABEL}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {instanceAdmin && (
                <DropdownMenuItem onClick={() => navigate({ to: "/system" })}>
                  System
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={async () => {
                  await authClient.signOut();
                  await navigate({ to: "/sign-in" });
                }}
              >
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            aria-label="Hide sidebar"
            onClick={() => {
              setOpen(false);
              setHidden(true);
            }}
            className={railItem}
          >
            <PanelLeftClose className="size-4" />
            <span className={railLabel}>Hide</span>
          </button>
        </nav>
        <div
          id="workflow-panel"
          inert={!open}
          className={`overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none ${open ? "w-60 border-l" : "w-0"}`}
        >
          <div className="flex max-h-[70svh] w-60 flex-col gap-1 p-1.5">
            <div className="flex items-center justify-between px-2 py-1">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Back"
                  onClick={() => setOpen(false)}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ArrowLeft className="size-4" />
                </button>
                <span className="font-medium">Workflows</span>
              </div>
              <button
                type="button"
                aria-label="New workflow"
                onClick={createWorkflow}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-4" />
              </button>
            </div>
            <ul className="flex flex-col gap-0.5 overflow-y-auto">
              {workflows.map((w) => (
                <li key={w.id}>
                  <Link
                    to="/p/$projectSlug/workflows/$workflowId"
                    params={{ projectSlug: slug, workflowId: w.id }}
                    onClick={() => setOpen(false)}
                    className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-muted"
                    activeProps={{ className: "bg-muted" }}
                  >
                    <span className="truncate">{w.name}</span>
                    {w.active && <span className="text-muted-foreground">Active</span>}
                  </Link>
                </li>
              ))}
              {workflows.length === 0 && (
                <li className="px-2 py-1.5 text-muted-foreground">No workflows yet.</li>
              )}
            </ul>
            <Link
              to="/p/$projectSlug/workflows"
              params={{ projectSlug: slug }}
              search={{ all: true }}
              onClick={() => setOpen(false)}
              className="rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-muted"
            >
              Manage and import
            </Link>
          </div>
        </div>
      </div>
      {newProject && (
        <ProjectDialog
          onClose={() => setNewProject(false)}
          onCreated={async (newSlug) => {
            setNewProject(false);
            await navigate({
              to: "/p/$projectSlug/workflows",
              params: { projectSlug: newSlug },
            });
          }}
        />
      )}
      <Outlet />
    </div>
  );
}
