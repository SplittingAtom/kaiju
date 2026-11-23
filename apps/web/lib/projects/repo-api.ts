/**
 * Repos in the web app (KOBE-768, spec workspace-git G16, G17, G19, G20): the Repo mirror routes
 * (`/v1/projects/:id/repo*`, KOBE-766) and Convert to repo (`/v1/projects/:id/repo-conversion*`,
 * KOBE-765). Answers are `@kobe/protocol` git-mirror.ts and git-conversions.ts, camelized. The
 * server decides who may do what; the UI only hides controls. No shape here carries a credential.
 */
import type {
  GitConversionStartBody,
  GitConversionView,
  GitRepoMirror,
  GitRepoView,
  RepoWorkingCopy as WireWorkingCopy,
} from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../api/client";
import type { Camelized } from "../api/casing";

export type RepoView = Camelized<GitRepoView>;
export type RepoMirror = Camelized<GitRepoMirror>;
export type RepoConversion = Camelized<GitConversionView>;
export type RepoWorkingCopy = Camelized<WireWorkingCopy>;

export interface AbandonedConversion {
  readonly conversion: RepoConversion;
  /** A repository the host created for the attempt, which Kobe leaves there. */
  readonly leftOnHost: { readonly fullName: string; readonly baseUrl: string } | null;
}

export interface RepoApi {
  /** `GET /v1/projects/:id/repo`: 404 `not_a_repo` for an ordinary project. */
  repo(id: string): Promise<ApiResult<RepoView>>;
  /** `POST .../repo/refresh` (202): the mirror as it is, `refreshing`; 429 with Retry-After. */
  refresh(id: string): Promise<ApiResult<RepoView>>;
  /** `POST .../repo/relink` (Workspace admins): another repository of a connected organization. */
  relink(id: string, connectionId: string, repository: string): Promise<ApiResult<RepoView>>;
  /** `POST .../repo/detach` (Workspace admins): an ordinary project again. */
  detach(id: string): Promise<ApiResult<{ readonly commitId: string; readonly seq: number }>>;
  /** `GET .../repo-conversion`: the latest attempt, or null. */
  conversion(id: string): Promise<ApiResult<RepoConversion | null>>;
  /** `POST .../repo-conversion` (202). Refusals keep their facts in `error.details`. */
  startConversion(id: string, body: GitConversionStartBody): Promise<ApiResult<RepoConversion>>;
  retryConversion(id: string): Promise<ApiResult<RepoConversion>>;
  abandonConversion(id: string): Promise<ApiResult<AbandonedConversion>>;
}

const enc = encodeURIComponent;

export function createRepoApi(teamId: string, fetchFn?: typeof fetch): RepoApi {
  const base = (id: string) => `/v1/projects/${enc(id)}`;
  const call = <T>(path: string, method: "GET" | "POST" = "GET", json?: unknown) =>
    apiRequest<T>(path, {
      method,
      ...(method === "POST" ? { json: json ?? {} } : {}),
      teamId,
      fetchFn,
      errorDetails: true,
    });
  const repoOf = async (res: ApiResult<{ readonly repo: RepoView }>) =>
    res.ok ? { ...res, data: res.data.repo } : res;
  const attemptOf = async <T extends RepoConversion | null>(
    res: ApiResult<{ readonly conversion: T }>,
  ) => (res.ok ? { ...res, data: res.data.conversion } : res);
  return {
    repo: async (id) => repoOf(await call(`${base(id)}/repo`)),
    refresh: async (id) => repoOf(await call(`${base(id)}/repo/refresh`, "POST")),
    relink: async (id, connectionId, repository) =>
      repoOf(
        await call(`${base(id)}/repo/relink`, "POST", { connection_id: connectionId, repository }),
      ),
    detach: (id) => call(`${base(id)}/repo/detach`, "POST"),
    conversion: async (id) => attemptOf(await call(`${base(id)}/repo-conversion`)),
    startConversion: async (id, body) =>
      attemptOf(await call(`${base(id)}/repo-conversion`, "POST", body)),
    retryConversion: async (id) =>
      attemptOf(await call(`${base(id)}/repo-conversion/retry`, "POST")),
    abandonConversion: (id) => call(`${base(id)}/repo-conversion/abandon`, "POST"),
  };
}
