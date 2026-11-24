import { withTeam, type Envelope, type KaijuDb } from "@kaiju/db";
import type { Logger } from "pino";
import type { GitHostNet } from "../../git-hosts/http.js";
import type { BlobStore } from "../../retention/blobs.js";
import { kickMirrorRefresh } from "../mirror/job.js";
import { requestMirrorRefresh } from "../mirror/store.js";
import type { RepoCommitWiring } from "./dispatch.js";

/**
 * What a commit to a Repo needs from the server (KOBE-767), with the Repo mirror wired in
 * (KOBE-766): after a direct commit, or when the default branch moved, Kaiju's copy is refreshed
 * at once (`kickMirrorRefresh`); after a pull request push the mirror job is asked for a pass.
 */
export function repoCommitWiring(deps: {
  readonly database: { readonly db: KaijuDb };
  readonly envelope: Envelope | undefined;
  readonly gitHostNet: GitHostNet;
  readonly publicUrl: string;
  readonly blobs?: BlobStore | undefined;
  readonly log?: Pick<Logger, "info" | "warn" | "error">;
}): RepoCommitWiring {
  const db = deps.database.db;
  const mirror = () => ({
    db,
    envelope: deps.envelope,
    net: deps.gitHostNet,
    blobs: deps.blobs,
    log: deps.log ?? silent,
  });
  return {
    envelope: deps.envelope,
    net: deps.gitHostNet,
    publicUrl: deps.publicUrl,
    refreshMirror: (teamId, repositoryId) => kickMirrorRefresh(mirror(), teamId, repositoryId),
    requestMirror: (teamId, repositoryId) =>
      withTeam(db, teamId, (tx) => requestMirrorRefresh(tx, teamId, { repositoryId })),
  };
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };
