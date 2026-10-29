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
  LogoMark,
  PROJECT_LABEL,
  Tooltip,
} from "@zerodot/ui";
import {
  Braces,
  ChartColumn,
  CircleUser,
  FolderOpen,
  KeyRound,
  ListChecks,
  LockKeyhole,
  LogOut,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Table2,
  Workflow,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AboutDialog } from "../components/about-dialog";
import { CommandPalette, type PaletteAction } from "../components/command-palette";
import { setFeedbackUser } from "../components/feedback-widget";
import { ProjectDialog } from "../components/project-dialog";
import { getIsInstanceAdmin, getProjectFn } from "../server/fns";

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
  { to: "/p/$projectSlug/runs", label: "Runs", icon: ListChecks },
  { to: "/p/$projectSlug/insights", label: "Insights", icon: ChartColumn },
  { to: "/p/$projectSlug/credentials", label: "Credentials", icon: LockKeyhole },
  { to: "/p/$projectSlug/variables", label: "Variables", icon: Braces },
  { to: "/p/$projectSlug/tables", label: "Data tables", icon: Table2 },
  { to: "/p/$projectSlug/api-keys", label: "API keys", icon: KeyRound },
  { to: "/p/$projectSlug/settings", label: "Project settings", icon: Settings },
];

const railItem =
  "flex size-9 items-center justify-center rounded-lg transition-colors duration-150 ease-out";
const railActive = { className: "bg-muted text-foreground" };
const railInactive = { className: "text-muted-foreground hover:bg-muted hover:text-foreground" };
const railButton = `${railItem} ${railInactive.className}`;

const HIDDEN_KEY = "zerodot:sidebar-hidden";

function ProjectLayout() {
  const { user, project, projects } = Route.useRouteContext();
  const navigate = useNavigate();
  const [newProject, setNewProject] = useState(false);
  const [about, setAbout] = useState(false);
  const [hidden, setHiddenState] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [instanceAdmin, setInstanceAdmin] = useState(false);
  const slug = project.slug;

  // Once per layout mount. The layout stays mounted while you move between pages.
  useEffect(() => {
    getIsInstanceAdmin()
      .then(setInstanceAdmin)
      .catch(() => setInstanceAdmin(false));
  }, []);

  // The feedback widget gets the name and email of who sends feedback, and the role.
  useEffect(() => {
    setFeedbackUser(
      { id: user.id, name: user.name, email: user.email },
      instanceAdmin ? "instance admin" : "member",
    );
    return () => setFeedbackUser(null);
  }, [user.id, user.name, user.email, instanceAdmin]);

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

  const paletteActions: PaletteAction[] = [
    ...navItems.map(({ to, label, icon: Icon }) => ({
      id: `page:${to}`,
      group: "Pages",
      label,
      icon: <Icon className="size-4" />,
      run: () =>
        navigate({
          to,
          params: { projectSlug: slug },
          ...(to === "/p/$projectSlug/workflows" ? { search: { all: true } } : {}),
        }),
    })),
    ...projects.map((p) => ({
      id: `project:${p.slug}`,
      group: `${PROJECT_LABEL[0]?.toUpperCase()}${PROJECT_LABEL.slice(1)}s`,
      label: p.name,
      icon: <FolderOpen className="size-4" />,
      run: () =>
        navigate({
          to: "/p/$projectSlug/workflows",
          params: { projectSlug: p.slug },
          search: { all: true },
        }),
    })),
    {
      id: "new-project",
      group: "Actions",
      label: `New ${PROJECT_LABEL}`,
      icon: <Plus className="size-4" />,
      run: () => setNewProject(true),
    },
    ...(instanceAdmin
      ? [
          {
            id: "system",
            group: "Actions",
            label: "System",
            icon: <Settings className="size-4" />,
            run: () => navigate({ to: "/system" }),
          },
        ]
      : []),
    {
      id: "sign-out",
      group: "Actions",
      label: "Sign out",
      icon: <LogOut className="size-4" />,
      run: async () => {
        await authClient.signOut();
        await navigate({ to: "/sign-in" });
      },
    },
  ];

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
        inert={hidden}
        className={`fixed top-1/2 left-3 z-20 flex -translate-y-1/2 items-stretch rounded-xl border bg-card shadow-md motion-reduce:transition-none ${animate ? "transition-[translate,opacity] duration-150 ease-out" : ""} ${hidden ? "pointer-events-none -translate-x-2 opacity-0" : ""}`}
      >
        <nav aria-label="Project" className="flex flex-col items-center gap-1 p-1.5">
          <button
            type="button"
            aria-label="About zerodot"
            onClick={() => setAbout(true)}
            className="flex size-9 items-center justify-center border-b pb-0.5 text-xs"
          >
            <LogoMark />
          </button>
          {navItems.map(({ to, label, icon: Icon }) => (
            <Tooltip key={to} label={label} side="right">
              {to === "/p/$projectSlug/workflows" ? (
                <Link
                  to={to}
                  params={{ projectSlug: slug }}
                  search={{ all: true }}
                  className={railItem}
                  activeProps={railActive}
                  inactiveProps={railInactive}
                >
                  <Icon className="size-4" />
                </Link>
              ) : (
                <Link
                  to={to}
                  params={{ projectSlug: slug }}
                  className={railItem}
                  activeProps={railActive}
                  inactiveProps={railInactive}
                >
                  <Icon className="size-4" />
                </Link>
              )}
            </Tooltip>
          ))}
          <span aria-hidden="true" className="my-0.5 h-px w-6 bg-border" />
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="Account" className={railButton}>
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
                      navigate({
                        to: "/p/$projectSlug/workflows",
                        params: { projectSlug: p.slug },
                        search: { all: true },
                      })
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
          <Tooltip label="Hide sidebar" side="right">
            <button type="button" onClick={() => setHidden(true)} className={railButton}>
              <PanelLeftClose className="size-4" />
            </button>
          </Tooltip>
        </nav>
      </div>
      <CommandPalette slug={slug} actions={paletteActions} />
      {about && <AboutDialog project={project.name} onClose={() => setAbout(false)} />}
      {newProject && (
        <ProjectDialog
          onClose={() => setNewProject(false)}
          onCreated={async (newSlug) => {
            setNewProject(false);
            await navigate({
              to: "/p/$projectSlug/workflows",
              params: { projectSlug: newSlug },
              search: { all: true },
            });
          }}
        />
      )}
      <Outlet />
    </div>
  );
}
