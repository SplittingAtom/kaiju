"use client";

/**
 * Repos as the Files panel sees them (KOBE-768, spec workspace-git G16, G17, G19, G20), beside the
 * projects of {@link WorkspaceProjectsProvider}: for each live Repo its repository and mirror
 * (`GET /v1/projects/:id/repo`) and the member's commit target and working copy
 * (`GET .../repo-status`: branch, ahead/behind), read when the set of Repos changes or one is asked
 * for; the Workspace's git connections (the Convert to repo offer and dialog, Relink, the admin
 * notices), read once the projects are in and again when a dialog opens; and in-app notices for
 * conversions the member manages that finished or failed while the panel was open: only those
 * projects' attempts are read (`GET .../repo-conversion`), every `pollMs` at first and less often
 * after that, and the projects are read again when one ends (retried a few times if that read
 * fails). Read failures leave a Repo without details, never an error over the panel.
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

/** Read a running conversion this often at first; then 1.5 times less often each time, up to the cap. */
export const CONVERSION_POLL_MS = 10_000;
const CONVERSION_POLL_MAX_MS = 60_000;
/** Reads of the projects after a conversion ended, when they fail. */
const RELOAD_RETRIES = 3;

export function useWorkspaceRepos({
  teamId,
  fetchFn,
  projects,
  status,
  commits,
  reload,
  pollMs = CONVERSION_POLL_MS,
}: {
  readonly teamId: string;
  readonly fetchFn: typeof fetch | undefined;
  readonly projects: readonly Project[];
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly commits: ProjectCommitsApi;
  readonly reload: () => void;
  readonly pollMs?: number | undefined;
}) {
  const ready = status === "ready";
  const repoApi: RepoApi = useMemo(() => createRepoApi(teamId, fetchFn), [teamId, fetchFn]);
  const [repos, setRepos] = useState<ReadonlyMap<string, RepoInfo>>(new Map());
  const [git, setGit] = useState<GitConnections | null>(null);
  const [notices, setNotices] = useState<readonly RepoNotice[]>([]);
  const [watched, setWatched] = useState("");
  const gitAsked = useRef(false);
  const names = useRef<ReadonlyMap<string, string>>(new Map());
  const reloadsLeft = useRef(0);

  const readOne = useCallback(
    async (id: string): Promise<RepoInfo> => {
      const [view, info] = await Promise.all([repoApi.repo(id), commits.repoStatus(id)]);
      return {
        view: view.ok ? view.data : null,
        status: info.ok ? info.data.repo : null,
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

  // Every Repo's details, read again when the set of Repos changes (review M3: not on every
  // reload of the projects; a Repo is read again on its own with `reloadRepo`).
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
    // A reload keeps `ready` (it stays "ready" while it reads), so this runs when the Repos change.
  }, [ready, repoIds, readOne]);

  const reloadRepo = useCallback(
    (id: string) => {
      void readOne(id).then((info) => setRepos((current) => new Map([...current, [id, info]])));
    },
    [readOne],
  );

  const readGit = useCallback(() => {
    void listGitConnections(teamId, fetchFn).then((res) => {
      if (!res.ok) return; // no Convert to repo offer; the server would refuse anyway
      setGit({
        connections: res.data.connections,
        enabled: res.data.site.enabled,
        admin: res.data.connections.some(isAdminView) || res.data.site.allowedHosts !== undefined,
      });
    });
  }, [teamId, fetchFn]);

  // The connections, once the projects are in (they also say whether the member is a Workspace
  // admin, review L1); `reloadGit` reads them again when a dialog opens (review L2).
  useEffect(() => {
    if (!ready || gitAsked.current) return;
    gitAsked.current = true;
    readGit();
  }, [ready, readGit]);

  const admin = git?.admin ?? false;
  // The conversions to follow: running ones of projects the member manages (review M3, L5).
  useEffect(() => {
    if (!ready) return;
    names.current = new Map(projects.map((p) => [p.id, p.name]));
    setWatched(
      live
        .filter((p) => p.repoConversion === "running" && managesProject(p, admin))
        .map((p) => p.id)
        .join(","),
    );
  }, [ready, projects, live, admin]);

  const reloadAfterEnd = useCallback(() => {
    reloadsLeft.current = RELOAD_RETRIES;
    reload();
  }, [reload]);

  // Follow them: their attempts only, with back-off; a notice and one reload when one ends.
  useEffect(() => {
    if (watched === "") return;
    const ids = watched.split(",");
    let stale = false;
    let delay = pollMs;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const results = await Promise.all(
        ids.map(async (id) => [id, await repoApi.conversion(id)] as const),
      );
      if (stale) return;
      const ended = results.flatMap(([id, res]) =>
        res.ok && res.data?.status !== "running" ? [[id, res.data] as const] : [],
      );
      if (ended.length === 0) {
        delay = Math.min(delay * 1.5, CONVERSION_POLL_MAX_MS);
        timer = setTimeout(() => void tick(), delay);
        return;
      }
      const fresh = ended.flatMap(([id, attempt]): RepoNotice[] => {
        const name = names.current.get(id) ?? "The project";
        if (attempt?.status === "completed") {
          return [
            { key: `${id}:done`, projectId: id, tone: "done", text: `${name} is now a Repo.` },
          ];
        }
        if (attempt?.status === "failed") {
          return [
            {
              key: `${id}:failed`,
              projectId: id,
              tone: "failed",
              text: `Converting ${name} to a Repo failed. Open Convert to repo… on it to see why, retry or abandon.`,
            },
          ];
        }
        return [];
      });
      setNotices((current) => [
        ...current.filter((n) => !fresh.some((f) => f.projectId === n.projectId)),
        ...fresh,
      ]);
      const gone = new Set(ended.map(([id]) => id));
      setWatched(ids.filter((id) => !gone.has(id)).join(","));
      reloadAfterEnd();
    };
    timer = setTimeout(() => void tick(), delay);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [watched, repoApi, pollMs, reloadAfterEnd]);

  // A read of the projects after a conversion ended failed: try again a few times.
  useEffect(() => {
    if (status === "ready") reloadsLeft.current = 0;
    if (status !== "error" || reloadsLeft.current === 0) return;
    const timer = setTimeout(() => {
      reloadsLeft.current -= 1;
      reload();
    }, pollMs);
    return () => clearTimeout(timer);
  }, [status, reload, pollMs]);

  const dismissNotice = useCallback(
    (key: string) => setNotices((current) => current.filter((n) => n.key !== key)),
    [],
  );

  return useMemo(
    () => ({ repoApi, repos, reloadRepo, git, reloadGit: readGit, notices, dismissNotice }),
    [repoApi, repos, reloadRepo, git, readGit, notices, dismissNotice],
  );
}
