"use client";

/**
 * Repos as the Files panel sees them (KOBE-768, spec workspace-git G16, G17, G19, G20), beside the
 * projects of {@link WorkspaceProjectsProvider}: for each live Repo its repository and mirror
 * (`GET /v1/projects/:id/repo`) and the member's commit target and working copy
 * (`GET .../repo-status`: branch, ahead/behind); the Workspace's git connections (the Convert to
 * repo offer and dialog, Relink), read once a project the member manages is listed; and in-app
 * notices for conversions that finished or failed while the panel was open (projects are read
 * again every `pollMs` while one runs). Read failures leave a Repo without details, never an error
 * over the panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isAdminView,
  listGitConnections,
  type GitAdminConnection,
  type GitMemberConnection,
} from "../../lib/admin/api/team/git";
import type { Project } from "../../lib/projects/api";
import type { ProjectCommitsApi, RepoCommitInfo } from "../../lib/projects/commits-api";
import { createRepoApi, type RepoApi, type RepoView } from "../../lib/projects/repo-api";
import { managesProject } from "./repo-row";

export interface RepoInfo {
  /** Null until read, or when it could not be read. */
  readonly view: RepoView | null;
  /** Where the member's commits go and their working copy; null when unknown. */
  readonly status: NonNullable<RepoCommitInfo["repo"]> | null;
}

export interface GitConnections {
  readonly connections: readonly (GitAdminConnection | GitMemberConnection)[];
  /** The Site allows git connections. */
  readonly enabled: boolean;
  /** The caller is a Workspace admin (the admin view of the connections). */
  readonly admin: boolean;
}

export interface RepoNotice {
  readonly key: string;
  readonly projectId: string;
  readonly text: string;
  readonly tone: "done" | "failed";
}

/** Read the projects again this often while a conversion runs. */
export const CONVERSION_POLL_MS = 10_000;

export function useWorkspaceRepos({
  teamId,
  fetchFn,
  projects,
  ready,
  commits,
  reload,
  pollMs = CONVERSION_POLL_MS,
}: {
  readonly teamId: string;
  readonly fetchFn: typeof fetch | undefined;
  readonly projects: readonly Project[];
  readonly ready: boolean;
  readonly commits: ProjectCommitsApi;
  readonly reload: () => void;
  readonly pollMs?: number | undefined;
}) {
  const repoApi: RepoApi = useMemo(() => createRepoApi(teamId, fetchFn), [teamId, fetchFn]);
  const [repos, setRepos] = useState<ReadonlyMap<string, RepoInfo>>(new Map());
  const [git, setGit] = useState<GitConnections | null>(null);
  const [notices, setNotices] = useState<readonly RepoNotice[]>([]);
  const gitAsked = useRef(false);
  const before = useRef<ReadonlyMap<string, Project> | null>(null);

  const readOne = useCallback(
    async (id: string): Promise<RepoInfo> => {
      const [view, status] = await Promise.all([repoApi.repo(id), commits.repoStatus(id)]);
      return {
        view: view.ok ? view.data : null,
        status: status.ok ? status.data.repo : null,
      };
    },
    [repoApi, commits],
  );

  const live = useMemo(() => projects.filter((p) => p.archivedAt === null), [projects]);
  const repoIds = useMemo(
    () =>
      live
        .filter((p) => p.kind === "repo")
        .map((p) => p.id)
        .join(","),
    [live],
  );

  // Every Repo's details, read again whenever the projects are.
  useEffect(() => {
    if (!ready) return;
    let stale = false;
    const ids = repoIds === "" ? [] : repoIds.split(",");
    void Promise.all(ids.map(async (id) => [id, await readOne(id)] as const)).then((rows) => {
      if (!stale) setRepos(new Map(rows));
    });
    return () => {
      stale = true;
    };
  }, [ready, repoIds, projects, readOne]);

  const reloadRepo = useCallback(
    (id: string) => {
      void readOne(id).then((info) => setRepos((current) => new Map([...current, [id, info]])));
    },
    [readOne],
  );

  // The connections, once a project the member manages is listed (owners and admins convert).
  const wantsGit = ready && live.some(managesProject);
  useEffect(() => {
    if (!wantsGit || gitAsked.current) return;
    gitAsked.current = true;
    void listGitConnections(teamId, fetchFn).then((res) => {
      if (!res.ok) return; // no Convert to repo offer; the server would refuse anyway
      setGit({
        connections: res.data.connections,
        enabled: res.data.site.enabled,
        admin: res.data.connections.some(isAdminView) || res.data.site.allowedHosts !== undefined,
      });
    });
  }, [wantsGit, teamId, fetchFn]);

  // Notices: a conversion that was running and is now done or failed.
  useEffect(() => {
    if (!ready) return;
    const now = new Map(projects.map((p) => [p.id, p]));
    const prev = before.current;
    before.current = now;
    if (prev === null) return;
    const fresh: RepoNotice[] = [];
    for (const [id, p] of now) {
      if (prev.get(id)?.repoConversion !== "running") continue;
      if (p.kind === "repo") {
        fresh.push({
          key: `${id}:done`,
          projectId: id,
          tone: "done",
          text: `${p.name} is now a Repo.`,
        });
      } else if (p.repoConversion === "failed") {
        fresh.push({
          key: `${id}:failed`,
          projectId: id,
          tone: "failed",
          text: `Converting ${p.name} to a Repo failed. Open Convert to repo… on it to see why, retry or abandon.`,
        });
      }
    }
    if (fresh.length > 0) {
      setNotices((current) => [
        ...current.filter((n) => !fresh.some((f) => f.projectId === n.projectId)),
        ...fresh,
      ]);
    }
  }, [ready, projects]);

  // While a conversion runs, read the projects again now and then.
  const running = ready && live.some((p) => p.repoConversion === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reload, pollMs);
    return () => clearInterval(timer);
  }, [running, reload, pollMs]);

  const dismissNotice = useCallback(
    (key: string) => setNotices((current) => current.filter((n) => n.key !== key)),
    [],
  );

  return useMemo(
    () => ({ repoApi, repos, reloadRepo, git, notices, dismissNotice }),
    [repoApi, repos, reloadRepo, git, notices, dismissNotice],
  );
}
