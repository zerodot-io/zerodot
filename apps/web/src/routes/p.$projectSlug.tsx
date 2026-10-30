// SPDX-License-Identifier: AGPL-3.0-only

import {
  BubbleChatIcon,
  ChartColumnIcon,
  Folder02Icon,
  FunctionOfXIcon,
  HistoryIcon,
  Key01Icon,
  Logout01Icon,
  Menu01Icon,
  PackageIcon,
  PlusSignIcon,
  ServerStack01Icon,
  Settings02Icon,
  SidebarLeft01Icon,
  SidebarLeftIcon,
  TableIcon,
  UserCircleIcon,
  VaultIcon,
  WorkflowSquare06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  createFileRoute,
  getRouteApi,
  Link,
  Outlet,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { authClient } from "@zerodot/auth/client";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
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
import { Fragment, useEffect, useMemo, useState } from "react";
import { AboutDialog } from "../components/about-dialog";
import { CommandPalette, type PaletteAction } from "../components/command-palette";
import { FeedbackWidget, openFeedback, setFeedbackUser } from "../components/feedback-widget";
import { NewProjectInput, ProjectDialog } from "../components/project-dialog";
import { type Release, UpdateNotice } from "../components/update-notice";
import { getIsInstanceAdmin, getProjectFn, getUpdateFn } from "../server/fns";

/** The root route has the feedback widget settings. */
const rootRoute = getRouteApi("__root__");

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

const navItems: { to: NavTo; label: string; icon: IconSvgElement }[] = [
  { to: "/p/$projectSlug/workflows", label: "Workflows", icon: WorkflowSquare06Icon },
  { to: "/p/$projectSlug/runs", label: "Runs", icon: HistoryIcon },
  { to: "/p/$projectSlug/insights", label: "Insights", icon: ChartColumnIcon },
  { to: "/p/$projectSlug/credentials", label: "Credentials", icon: VaultIcon },
  { to: "/p/$projectSlug/variables", label: "Variables", icon: FunctionOfXIcon },
  { to: "/p/$projectSlug/tables", label: "Data tables", icon: TableIcon },
  { to: "/p/$projectSlug/api-keys", label: "API keys", icon: Key01Icon },
  { to: "/p/$projectSlug/settings", label: "Project settings", icon: Settings02Icon },
];

const railItem =
  "flex size-9 items-center justify-center rounded-lg transition-colors duration-150 ease-out";
const railActive = { className: "bg-muted text-foreground" };
const railInactive = { className: "text-muted-foreground hover:bg-muted hover:text-foreground" };
const railButton = `${railItem} ${railInactive.className}`;

const sheetItem =
  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 ease-out";
const sheetActive = { className: "bg-muted text-foreground" };
const sheetInactive = { className: "text-muted-foreground hover:bg-muted hover:text-foreground" };
const sheetButton = `${sheetItem} ${sheetInactive.className}`;

const HIDDEN_KEY = "zerodot:sidebar-hidden";

function ProjectLayout() {
  const { user, project, projects } = Route.useRouteContext();
  const navigate = useNavigate();
  const [newProject, setNewProject] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [about, setAbout] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [hidden, setHiddenState] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [instanceAdmin, setInstanceAdmin] = useState(false);
  const [releases, setReleases] = useState<Release[]>([]);
  const slug = project.slug;
  const { widgetId, system } = rootRoute.useLoaderData();
  const feedbackProperties = useMemo(() => ({ version: __APP_VERSION__, system }), [system]);

  // Once per layout mount. The layout stays mounted while you move between pages.
  useEffect(() => {
    getIsInstanceAdmin()
      .then(setInstanceAdmin)
      .catch(() => setInstanceAdmin(false));
  }, []);

  // The instance admin sees the update dot while a newer version exists. The server caches the answer.
  useEffect(() => {
    if (!instanceAdmin) return;
    getUpdateFn({ data: { current: __APP_VERSION__ } })
      .then(({ releases }) => setReleases(releases))
      .catch(() => undefined);
  }, [instanceAdmin]);

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
      icon: <HugeiconsIcon icon={Icon} className="size-4" />,
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
      icon: <HugeiconsIcon icon={Folder02Icon} className="size-4" />,
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
      icon: <HugeiconsIcon icon={PlusSignIcon} className="size-4" />,
      run: () => setNewProject(true),
    },
    ...(instanceAdmin
      ? [
          {
            id: "system",
            group: "Actions",
            label: "System",
            icon: <HugeiconsIcon icon={Settings02Icon} className="size-4" />,
            run: () => navigate({ to: "/system" }),
          },
        ]
      : []),
    {
      id: "sign-out",
      group: "Actions",
      label: "Sign out",
      icon: <HugeiconsIcon icon={Logout01Icon} className="size-4" />,
      run: async () => {
        await authClient.signOut();
        await navigate({ to: "/sign-in" });
      },
    },
  ];

  async function signOut() {
    if (!confirmSignOut) {
      setConfirmSignOut(true);
      return;
    }
    await authClient.signOut();
    await navigate({ to: "/sign-in" });
  }

  // The rail floats over every page. Showing or hiding it does not move the page.
  // On a phone, a menu button opens the same links in a bottom sheet.
  return (
    <div className="min-h-svh max-md:pb-20 max-md:has-data-editor:pb-0">
      <button
        type="button"
        aria-label="Open menu"
        onClick={() => setNavOpen(true)}
        className="fixed bottom-4 left-4 z-20 flex size-11 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-md hover:text-foreground md:hidden"
      >
        <HugeiconsIcon icon={Menu01Icon} className="size-5" />
      </button>
      <Drawer
        open={navOpen}
        onOpenChange={(open) => {
          setNavOpen(open);
          if (!open) setConfirmSignOut(false);
        }}
      >
        <DrawerContent>
          <div className="border-b p-4 pr-12">
            <DrawerTitle>{project.name}</DrawerTitle>
            <p className="text-muted-foreground">{user.email}</p>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2">
            <nav aria-label="Project" className="flex flex-col">
              {navItems.map(({ to, label, icon: Icon }) => (
                <Fragment key={to}>
                  {to === "/p/$projectSlug/settings" && instanceAdmin && (
                    <Link
                      to="/system/nodes"
                      onClick={() => setNavOpen(false)}
                      className={sheetItem}
                      activeProps={sheetActive}
                      inactiveProps={sheetInactive}
                    >
                      <HugeiconsIcon icon={PackageIcon} className="size-4" />
                      Nodes
                    </Link>
                  )}
                  {to === "/p/$projectSlug/workflows" ? (
                    <Link
                      to={to}
                      params={{ projectSlug: slug }}
                      search={{ all: true }}
                      onClick={() => setNavOpen(false)}
                      className={sheetItem}
                      activeProps={sheetActive}
                      inactiveProps={sheetInactive}
                    >
                      <HugeiconsIcon icon={Icon} className="size-4" />
                      {label}
                    </Link>
                  ) : (
                    <Link
                      to={to}
                      params={{ projectSlug: slug }}
                      onClick={() => setNavOpen(false)}
                      className={sheetItem}
                      activeProps={sheetActive}
                      inactiveProps={sheetInactive}
                    >
                      <HugeiconsIcon icon={Icon} className="size-4" />
                      {label}
                    </Link>
                  )}
                </Fragment>
              ))}
            </nav>
            <div className="flex flex-col border-t pt-2">
              <p className="px-3 py-2 text-muted-foreground capitalize">{PROJECT_LABEL}s</p>
              {projects.map((p) => (
                <Link
                  key={p.slug}
                  to="/p/$projectSlug/workflows"
                  params={{ projectSlug: p.slug }}
                  search={{ all: true }}
                  onClick={() => setNavOpen(false)}
                  className={`${sheetButton} ${p.slug === slug ? "font-medium text-foreground" : ""}`}
                >
                  <HugeiconsIcon icon={Folder02Icon} className="size-4" />
                  {p.name}
                </Link>
              ))}
              <button
                type="button"
                onClick={() => {
                  setNavOpen(false);
                  setNewProject(true);
                }}
                className={sheetButton}
              >
                <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
                New {PROJECT_LABEL}
              </button>
            </div>
            <div className="flex flex-col border-t pt-2">
              {widgetId && (
                <button
                  type="button"
                  onClick={() => {
                    setNavOpen(false);
                    openFeedback();
                  }}
                  className={sheetButton}
                >
                  <HugeiconsIcon icon={BubbleChatIcon} className="size-4" />
                  Send feedback
                </button>
              )}
              {instanceAdmin && (
                <Link to="/system" onClick={() => setNavOpen(false)} className={sheetButton}>
                  <HugeiconsIcon icon={ServerStack01Icon} className="size-4" />
                  System
                </Link>
              )}
              <button
                type="button"
                onClick={() => {
                  setNavOpen(false);
                  setAbout(true);
                }}
                className={sheetButton}
              >
                <LogoMark className="w-4" />
                About zerodot
              </button>
              {/* The first tap asks to confirm. The second tap signs out. */}
              <button
                type="button"
                onClick={signOut}
                className={`${sheetButton} ${confirmSignOut ? "text-destructive hover:text-destructive" : ""}`}
              >
                <HugeiconsIcon icon={Logout01Icon} className="size-4" />
                {confirmSignOut ? "Tap again to sign out" : "Sign out"}
              </button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
      <button
        type="button"
        aria-label="Show sidebar"
        inert={!hidden}
        onClick={() => setHidden(false)}
        className={`fixed top-1/2 left-3 z-20 flex size-9 -translate-y-1/2 max-md:hidden items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-md hover:text-foreground motion-reduce:transition-none ${animate ? "transition-opacity duration-150 ease-out" : ""} ${hidden ? "opacity-100" : "opacity-0"}`}
      >
        <HugeiconsIcon icon={SidebarLeftIcon} className="size-4" />
      </button>
      <div
        inert={hidden}
        className={`fixed top-1/2 left-3 z-20 flex -translate-y-1/2 items-stretch max-md:hidden rounded-xl border bg-card shadow-md motion-reduce:transition-none ${animate ? "transition-[translate,opacity] duration-150 ease-out" : ""} ${hidden ? "pointer-events-none -translate-x-2 opacity-0" : ""}`}
      >
        <nav aria-label="Project" className="flex flex-col items-center gap-1 p-1.5">
          <Tooltip label="About zerodot" side="right">
            <button
              type="button"
              aria-label="About zerodot"
              onClick={() => setAbout(true)}
              className="flex size-9 cursor-pointer items-center justify-center border-b pb-0.5 text-xs"
            >
              <LogoMark />
            </button>
          </Tooltip>
          {navItems.map(({ to, label, icon: Icon }) => (
            <Fragment key={to}>
              {/* Nodes are for the whole instance. The link shows before the project settings. */}
              {to === "/p/$projectSlug/settings" && instanceAdmin && (
                <Tooltip label="Nodes" side="right">
                  <Link
                    to="/system/nodes"
                    className={railItem}
                    activeProps={railActive}
                    inactiveProps={railInactive}
                  >
                    <HugeiconsIcon icon={PackageIcon} className="size-4" />
                  </Link>
                </Tooltip>
              )}
              <Tooltip label={label} side="right">
                {to === "/p/$projectSlug/workflows" ? (
                  <Link
                    to={to}
                    params={{ projectSlug: slug }}
                    search={{ all: true }}
                    className={railItem}
                    activeProps={railActive}
                    inactiveProps={railInactive}
                  >
                    <HugeiconsIcon icon={Icon} className="size-4" />
                  </Link>
                ) : (
                  <Link
                    to={to}
                    params={{ projectSlug: slug }}
                    className={railItem}
                    activeProps={railActive}
                    inactiveProps={railInactive}
                  >
                    <HugeiconsIcon icon={Icon} className="size-4" />
                  </Link>
                )}
              </Tooltip>
            </Fragment>
          ))}
          <span aria-hidden="true" className="my-0.5 h-px w-6 bg-border" />
          <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open);
              if (!open) {
                setCreating(false);
                setConfirmSignOut(false);
              }
            }}
          >
            <DropdownMenuTrigger aria-label="Account" className={railButton}>
              <HugeiconsIcon icon={UserCircleIcon} className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex items-center gap-1.5 capitalize">
                  <HugeiconsIcon icon={Folder02Icon} className="size-4" />
                  {PROJECT_LABEL}s
                </DropdownMenuLabel>
                {/* Tree: the line under the folder icon joins the projects to the label. */}
                <div className="ml-4 border-l pl-1">
                  {projects.map((p) => (
                    <DropdownMenuItem
                      key={p.slug}
                      className={p.slug === slug ? "font-medium" : undefined}
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
                  {creating ? (
                    <NewProjectInput
                      onCancel={() => setCreating(false)}
                      onCreated={async (newSlug) => {
                        setMenuOpen(false);
                        setCreating(false);
                        await navigate({
                          to: "/p/$projectSlug/workflows",
                          params: { projectSlug: newSlug },
                          search: { all: true },
                        });
                      }}
                    />
                  ) : (
                    <DropdownMenuItem closeOnClick={false} onClick={() => setCreating(true)}>
                      <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
                      New {PROJECT_LABEL}
                    </DropdownMenuItem>
                  )}
                </div>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {widgetId && (
                <DropdownMenuItem onClick={openFeedback}>
                  <HugeiconsIcon icon={BubbleChatIcon} className="size-4" />
                  Send feedback
                </DropdownMenuItem>
              )}
              {instanceAdmin && (
                <DropdownMenuItem onClick={() => navigate({ to: "/system" })}>
                  <HugeiconsIcon icon={ServerStack01Icon} className="size-4" />
                  System
                </DropdownMenuItem>
              )}
              {/* The first click asks to confirm. The second click signs out. */}
              <DropdownMenuItem
                closeOnClick={false}
                variant={confirmSignOut ? "destructive" : "default"}
                onClick={signOut}
              >
                <HugeiconsIcon icon={Logout01Icon} className="size-4" />
                {confirmSignOut ? "Click again to sign out" : "Sign out"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip label="Hide sidebar" side="right">
            <button type="button" onClick={() => setHidden(true)} className={railButton}>
              <HugeiconsIcon icon={SidebarLeft01Icon} className="size-4" />
            </button>
          </Tooltip>
        </nav>
      </div>
      <CommandPalette slug={slug} actions={paletteActions} />
      <UpdateNotice releases={releases} />
      <FeedbackWidget widgetId={widgetId} properties={feedbackProperties} />
      {about && (
        <AboutDialog
          project={project.name}
          update={releases[0]?.version}
          onClose={() => setAbout(false)}
        />
      )}
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
