/**
 * What the fake server holds (KOBE-717: the fields of `FakeKobe`, out of `fake-kobe.ts`). Tests
 * read and set these on `FakeKobe` as before; the area handlers read them through `FakeCore`.
 */
import type { KobeEventPayload } from "@kobe/protocol";
import type { FakeEventSource } from "../fake-kobe";
import { FakeFileLinks } from "../fake-file-links";
import { FakeFolders } from "../fake-folders";
import { FakeWorkspaceChanges } from "../fake-workspace-changes";
import { FakeWorkspaceEvents } from "../fake-workspace-events";
import {
  uuid,
  type FakeArtifact,
  type FakeRun,
  type FakeRunnableAgent,
  type FakeTeamModel,
  type FakeThread,
  type Json,
  type RecordedRequest,
} from "./state";

export class FakeStore {
  readonly teamId = uuid(1, 1);
  readonly requests: RecordedRequest[] = [];
  readonly threads = new Map<string, FakeThread>();
  /** The team's thread folders (KOBE-536): `/v1/thread-folders`, filing and `?folder=`. */
  readonly folders = new FakeFolders(() => this.threads.values(), uuid(3, 1));
  /** Thread–file links (KOBE-612): `/v1/threads/file-links`, `/v1/workspace/file-threads`. */
  readonly fileLinks = new FakeFileLinks((id) => {
    const t = this.threads.get(id);
    return t === undefined || t.deleted_at !== null ? undefined : t.title;
  });
  readonly runs = new Map<string, FakeRun>();
  /** `GET /v1/runs/{id}/usage` answers (KOBE-43); absent: a run without model calls. */
  readonly usage = new Map<string, Json>();
  /** `GET /v1/team/budgets/status` (KOBE-42). */
  budgetStatus: Json = { state: "ok", lines: [] };
  /** Requests answered with an error once, keyed "METHOD /path" (e.g. to simulate a 503). */
  readonly failNext = new Map<string, Response>();
  /** Compact now (KOBE-213): when set, a compaction answers only once it resolves. */
  compactGate: Promise<void> | undefined;
  /** Branch summaries asked for (KOBE-548): the request bodies, in order. */
  readonly branchSummaryRequests: Json[] = [];
  /** The caller's workspace (KOBE-194): path (no leading slash) -> bytes; listed per folder. */
  readonly workspaceFiles = new Map<string, Uint8Array>();
  /** `GET /v1/workspace/changes` (KOBE-496): tests `announce` changes to open file tabs. */
  readonly workspaceChanges = new FakeWorkspaceChanges(this.workspaceFiles);
  /** `GET /v1/workspace/events` and `POST /v1/workspace/sync` (KOBE-599). */
  readonly workspaceEvents = new FakeWorkspaceEvents();
  /** Folders listed as rows of their parent (KOBE-612); files alone list no folders. */
  readonly workspaceDirs = new Set<string>();
  /** Folders listed so far (`GET /v1/workspace/files`), to assert one request per thread. */
  readonly workspaceListings: string[] = [];
  /** The site catalog with the team's choice (KOBE-44); empty = no models route answers. */
  readonly teamModels: FakeTeamModel[] = [];
  /** The member's stored layout preferences (KOBE-202), wire casing; PUTs merge into it. */
  preferences: Json = {};
  /** The caller's role in the active team, as `GET /v1/me/teams` lists it. */
  teamRole: "team_admin" | "contributor" | "member" = "member";
  /** The caller's other teams (KOBE-419's team selector); `PUT /v1/me/teams/active` is recorded. */
  readonly otherTeams: { id: string; slug: string; name: string; role: string }[] = [];
  /** The session's active team (`GET /v1/me/teams`); null: none yet, the client activates one. */
  activeTeamId: string | null = this.teamId;
  /** The user's last active team in any session (KOBE-456); PUTs to the active team set it. */
  lastTeamId: string | null = null;
  /** `GET /v1/agents/runnable` (KOBE-122), in this order; `runnablePageSize` pages it. */
  readonly runnableAgents: FakeRunnableAgent[] = [];
  runnablePageSize = 200;
  /** The server holds the queue after Stop (KOBE-26); false = the KOBE-30 behaviour (next starts). */
  pauseOnStop = true;
  /** Approvals asked with `requestApproval` (KOBE-37), by id. */
  readonly approvals = new Map<
    string,
    { runId: string; payload: KobeEventPayload<"approval.requested">; status: string }
  >();

  /** Request-access requests (KOBE-39), newest last; `enabled`: domains already enabled. */
  readonly egressRequests: Json[] = [];
  readonly enabledDomains = new Set<string>();

  /** Artifacts of `GET /v1/artifacts*` (KOBE-55 D-6), by id. */
  readonly artifacts = new Map<string, FakeArtifact>();

  /** Shared files of `GET /v1/files/:id/content` (KOBE-150), by id; `status` makes the download fail. */
  readonly sharedFiles = new Map<string, { readonly bytes: Uint8Array; readonly status: number }>();
  /** `GET /v1/skills/drafts/saves?threadId=` (KOBE-442): the server's record of save_skill_draft calls. */
  readonly skillDraftSaves = new Map<string, readonly Record<string, unknown>[]>();
  /** `GET /v1/threads/{id}/file-edit-proposals` (KOBE-462): the thread's proposals, wire casing. */
  readonly fileEditProposals = new Map<string, readonly Record<string, unknown>[]>();
  /**
   * `GET /v1/threads/{id}/files` (KOBE-488): the agent-written files, wire casing; a thread named
   * in `threadFilesHidden` answers 404 (a shared reader). Counts the reads in `threadFilesReads`.
   */
  readonly threadFiles = new Map<string, readonly Record<string, unknown>[]>();
  readonly threadFilesHidden = new Set<string>();
  threadFilesReads = 0;
  /**
   * `GET /v1/threads/{id}/branches` (CT2, KOBE-545): labels and remembered-rule runs per thread
   * (empty when unset); a thread in `branchesFailing` answers 500. Reads counted in `branchesReads`.
   */
  readonly branches = new Map<
    string,
    {
      readonly labels: readonly { entry_id: string; label: string }[];
      readonly runs: readonly { user_entry_id: string; remembered_rule: boolean }[];
    }
  >();
  readonly branchesFailing = new Set<string>();
  /** `GET /v1/threads/{id}/egress-blocked` reads (KOBE-605). */
  egressBlockedReads = 0;
  /** Label writes as the route took them (CT9, KOBE-546). */
  readonly labelWrites: { threadId: string; entryId: string; label: string | null }[] = [];
  branchesReads = 0;
  /**
   * `GET /v1/threads/{id}/sync-conflicts` (KOBE-492): open conflicts, wire casing, newest first; a
   * thread in `threadFilesHidden` answers 404 (a shared reader). Settles are recorded in
   * `syncConflictActions` and remove the row; reads are counted in `syncConflictReads`.
   */
  readonly syncConflicts = new Map<string, readonly Record<string, unknown>[]>();
  readonly syncConflictActions: { conflictId: string; action: string }[] = [];
  syncConflictReads = 0;
  /** `DELETE /v1/workspace/files?path=` (KOBE-492's Delete the copy), in order. */
  readonly workspaceDeletes: string[] = [];
  /** Message bodies as `POST /v1/threads/{id}/messages` received them (KOBE-463: `viewing`). */
  readonly submittedBodies: Json[] = [];
  /** `PUT /v1/workspace/file` saves (KOBE-463): path, base version and the saved text. */
  readonly workspaceSaves: { path: string; base: string; text: string }[] = [];
  /** When set, a save answers only once it resolves (a save in flight, KOBE-463 review). */
  saveGate: Promise<void> | undefined;

  /** In-app notifications the bell lists (KOBE-181), newest first. */
  readonly notifications: Json[] = [];

  /**
   * MCP Apps (KOBE-438): `GET /v1/threads/{id}/app-results` (wire casing) by thread id, and the
   * stored results `GET …/app-results/{ref}` serves, by ref.
   */
  readonly appResults = new Map<string, Json[]>();
  readonly appResultBodies = new Map<string, Json>();

  /**
   * MCP Apps in the rail (KOBE-440): `GET /v1/team/apps` (`apps`, `needsKey`, as the server
   * sends them), and rail launches: `POST /v1/threads/{id}/app-cards` inserts an app card at the
   * leaf (queued during a run, inserted when it ends), `POST /v1/threads/app-cards` starts a
   * thread titled after the app, `DELETE …/app-cards/{ref}` removes a waiting card.
   */
  teamApps: Json[] = [];
  teamAppsNeedKey: Json[] = [];
  /** An app's own `tools/call` (KOBE-436): answered with this refusal when set, else a result. */
  appCallError: { status: number; code: string; message: string } | null = null;
  /** `POST /v1/team/apps/{id}/calls` result when not refused. */
  appCallResult: Record<string, unknown> = { content: [{ type: "text", text: "rows" }] };

  /** Like the server's re-check at insertion (review LOW-2): waiting cards are dropped. */
  dropWaitingCards = false;

  /**
   * Like the real server, where the run's end commits first and the promotion that inserts its
   * waiting cards follows in a transaction of its own (KOBE-415): the cards stay waiting at the
   * end until `insertWaitingCards` is called.
   */
  deferCardInsertion = false;

  /** `GET /v1/threads/{id}/markers` (KOBE-209), wire casing, by thread id. */
  readonly threadMarkers = new Map<
    string,
    {
      runs: Json[];
      approvals: Json[];
      skills?: Json[];
      projects?: Json[];
      agents?: Json[];
      skill_updates?: Json[];
    }
  >();

  /** The caller's answer ratings (KOBE-275), wire casing, by run id. */
  readonly feedback = new Map<string, Json>();

  /** The caller's shared eval cases (KOBE-276), wire casing, by run id. */
  readonly evalCases = new Map<string, Json>();
  /** What a run's eval case preview offers to add (KOBE-276), wire casing, by run id. */
  readonly evalCaseAvailable = new Map<string, Json>();

  /** Offloaded entry bodies (KOBE-208), by entry id. */
  readonly entryBodies = new Map<string, Json>();
  /**
   * The composer's + menu (KOBE-451): the member's connectors (wire casing, without `enabled`),
   * each thread's off ones, and the skills a run loads.
   */
  readonly chatConnectors: Json[] = [];
  readonly connectorsOff = new Map<string, Set<string>>();
  readonly chatSkills: string[] = [];
  /** `GET /v1/threads/{id}/export` answers this error instead of the Markdown (KOBE-450). */
  exportRefusal: { status: number; code: string; message: string } | null = null;
  /** `GET /v1/threads/{id}/usage` runs (KOBE-43/208), by thread id. */
  readonly threadUsage = new Map<string, Json[]>();
  /** Its `latest_call` (KOBE-211, wire casing), by thread id; absent: null. */
  readonly threadLatestCall = new Map<string, Json>();
  /**
   * `GET /v1/threads/{id}/context` answers (KOBE-471), by thread id, in order; the last repeats.
   * Absent: a 409 `context_unsupported`. A read-only thread is a 403 `not_owner`.
   */
  readonly threadContext = new Map<string, { status: number; body: unknown }[]>();

  /**
   * `GET /v1/threads/{id}/context/memories` items (KOBE-382, wire casing), by thread id; absent:
   * none (`run_id` null). A read-only thread is a 403 `not_owner`.
   */
  readonly threadMemories = new Map<string, Json[]>();
  /** Threads whose memories are an earlier run's (`latest: false`). */
  readonly threadMemoriesEarlier = new Set<string>();

  /**
   * Learn from this chat (KOBE-395): each thread's Learn state (wire casing, merged over the
   * default), by thread id; absent: Learn unavailable (no learning model). Starts are recorded;
   * `learnRefusal` makes the starts refuse. A start marks the thread's pass running.
   */
  readonly learnState = new Map<string, Json>();
  readonly learnStarts: { threadId: string; mode: string }[] = [];
  learnRefusal: { status: number; code: string; message: string } | null = null;

  /** Project heads for the history and file reads of a proposal card (KOBE-592), by project id. */
  readonly projectHeads = new Map<string, { seq: number; files: Map<string, string> }>();
  /** `POST .../commits/from-proposal` bodies, in order. */
  readonly fromProposalRequests: Json[] = [];
  /** What the next from-proposal answers (default: committed at head + 1). */
  nextFromProposal: { status: number; body: Json } | undefined;

  /** `GET /v1/projects` (the caller's live projects): a move may target these only (CE19). */
  readonly projects: Json[] = [];

  /** `GET /v1/me/checkouts` (Workspaces CM2). */
  readonly checkouts: Json[] = [];
  /** Project files by project id (Add to project, KOBE-585): paths only. */
  readonly projectFiles = new Map<string, string[]>();

  /** Answers the next organize call with this refusal instead (once). */
  refuseOrganize: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
  } | null = null;

  /** The team's next retention shortening (KOBE-18 banner); null: none. */
  upcomingRetention: { period: string; effective_at: string } | null = null;

  // --- the server's own counters and connections (were private to `FakeKobe`) -----------------

  /** Ids handed out so far, per kind. */
  readonly counters = {
    thread: 0,
    run: 0,
    entry: 0,
    queue: 0,
    artifact: 0,
    card: 0,
    organize: 0,
    evalCase: 0,
  };
  /** Every run stream opened (closed ones leave it). */
  readonly sources = new Set<FakeEventSource>();
  /** App cards launched during a run, inserted when it ends (KOBE-440), by thread id. */
  readonly queuedCards = new Map<string, { threadId: string; app: Json; ref: string }[]>();
}
