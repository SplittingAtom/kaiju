"use client";

/**
 * The active workspace's projects as the chat sees them (Workspaces FP1-FP4, CM8; KOBE-581): the
 * readable projects by slug (names, roles and the "All projects (n)" count) and the member's own
 * checkouts (the "editing" marks, writable folders and the editor's controls). Read lazily: the
 * first `ensure()` (the Files tree shows a projects/ folder, a project file opens, a project
 * header's menu opens) loads both; `reload()` after a checkout, commit or discard. Without the
 * provider (pages outside the chat) every project folder stays read-only, as before.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createProjectsApi, type Project, type ProjectsApi } from "../../lib/projects/api";
import {
  createCommitsApi,
  type ProjectCheckout,
  type ProjectCommitsApi,
} from "../../lib/projects/commits-api";
import type { RepoApi } from "../../lib/projects/repo-api";
import {
  useWorkspaceRepos,
  type GitConnections,
  type RepoInfo,
  type RepoNotice,
} from "./workspace-repos";

export interface WorkspaceProjects {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly bySlug: ReadonlyMap<string, Project>;
  /** The member's checkouts by slug. */
  readonly checkouts: ReadonlyMap<string, ProjectCheckout>;
  readonly checkedOut: ReadonlySet<string>;
  /** Projects the member can read (not archived): the "All projects (n)" link. */
  readonly total: number;
  readonly projects: ProjectsApi;
  readonly commits: ProjectCommitsApi;
  /** KOBE-768: each live Repo's repository, mirror and the member's working copy, by project id. */
  readonly repos: ReadonlyMap<string, RepoInfo>;
  readonly repoApi: RepoApi;
  /** The Workspace's git connections; null until read (or unreadable, or nothing to convert). */
  readonly git: GitConnections | null;
  /** Conversions that finished or failed while the panel was open. */
  readonly notices: readonly RepoNotice[];
  dismissNotice(key: string): void;
  reloadRepo(projectId: string): void;
  /** Read the git connections again (a dialog opens). */
  reloadGit(): void;
  ensure(): void;
  reload(): void;
}

const Context = createContext<WorkspaceProjects | null>(null);

export function useWorkspaceProjects(): WorkspaceProjects | null {
  return useContext(Context);
}

const EMPTY_SET: ReadonlySet<string> = new Set();

interface Loaded {
  readonly projects: readonly Project[];
  readonly checkouts: readonly ProjectCheckout[];
}

export function WorkspaceProjectsProvider({
  teamId,
  fetchFn,
  conversionPollMs,
  children,
}: {
  readonly teamId: string;
  readonly fetchFn?: typeof fetch | undefined;
  /** How often a running conversion is read at first (tests shorten it). */
  readonly conversionPollMs?: number | undefined;
  readonly children: ReactNode;
}) {
  const projects = useMemo(() => createProjectsApi(teamId, fetchFn), [teamId, fetchFn]);
  const commits = useMemo(() => createCommitsApi(teamId, fetchFn), [teamId, fetchFn]);
  const [status, setStatus] = useState<WorkspaceProjects["status"]>("idle");
  const [loaded, setLoaded] = useState<Loaded>({ projects: [], checkouts: [] });
  const seq = useRef(0);
  /** "idle" | "loading" | "ready" | "error", read by `ensure` without re-creating it. */
  const current = useRef<WorkspaceProjects["status"]>("idle");
  const setBoth = useCallback((next: WorkspaceProjects["status"]) => {
    current.current = next;
    setStatus(next);
  }, []);

  const reload = useCallback(() => {
    const n = ++seq.current;
    if (current.current !== "ready") setBoth("loading");
    void Promise.all([projects.list(false), commits.myCheckouts()]).then(([list, mine]) => {
      if (n !== seq.current) return;
      // Either unreadable: an error state (never "no checkouts", which would lock working
      // copies read-only); the next ensure() tries again.
      if (!list.ok || !mine.ok) {
        console.warn("files: could not read the projects or checkouts", {
          projects: list.ok ? null : list.error,
          checkouts: mine.ok ? null : mine.error,
        });
        setBoth("error");
        return;
      }
      setLoaded({ projects: list.data, checkouts: mine.data });
      setBoth("ready");
    });
  }, [projects, commits, setBoth]);

  const ensure = useCallback(() => {
    if (current.current === "idle" || current.current === "error") reload();
  }, [reload]);

  const repoState = useWorkspaceRepos({
    teamId,
    fetchFn,
    projects: loaded.projects,
    status,
    commits,
    reload,
    pollMs: conversionPollMs,
  });

  const value = useMemo<WorkspaceProjects>(() => {
    const bySlug = new Map(loaded.projects.map((p) => [p.slug, p]));
    const checkouts = new Map(loaded.checkouts.map((c) => [c.slug, c]));
    // Only a known, live project's checkout makes its folder writable (an archived or unknown
    // one stays read-only, as the server would refuse its writes).
    const writable = [...checkouts.keys()].filter((slug) => bySlug.get(slug)?.archivedAt === null);
    return {
      status,
      bySlug,
      checkouts,
      checkedOut: writable.length === 0 ? EMPTY_SET : new Set(writable),
      total: loaded.projects.filter((p) => p.archivedAt === null).length,
      projects,
      commits,
      ...repoState,
      ensure,
      reload,
    };
  }, [status, loaded, projects, commits, repoState, ensure, reload]);

  return <Context value={value}>{children}</Context>;
}
