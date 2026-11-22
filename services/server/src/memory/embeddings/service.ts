import { withTeam, type KobeDb } from "@kobe/db";
import { SERVER_CALL_LIMITS, type SemanticMemoryScope } from "@kobe/protocol";
import type { Logger } from "pino";
import type { BackgroundTasks } from "../../background.js";
import type { EmbeddingClient } from "../../models/embedding-client.js";
import { ServerCallError } from "../../models/gateway-client.js";
import { embeddingModelFor, type EmbeddingModel } from "./model.js";
import { documentText, queryText } from "./prefixes.js";
import { pendingVersions, writeVectors, type VectorTable } from "./vector-store.js";
import { readVectorSupport, type VectorSupport } from "./vector-support.js";
import { PendingQueries, runWantsVectors } from "./query-prefetch.js";
import type { ListenClient } from "../../pg-listen.js";
import { MEMORY_SETTINGS_CHANNEL } from "../site-settings.js";

/**
 * Memory embeddings (KOBE-409): embed on save, the selector's query embedding and what the
 * backfill job (`backfill.ts`) and the Site console read. Every call goes through the model
 * gateway with a `memory_embed` server-call token. Billing (Chris, 2026-11-15): a save is paid by
 * the person saving, in the Workspace they act in; the query embedding by the run's member and
 * Workspace (the token names the run). A Workspace at 100 % of a budget line gets no vector (the
 * gateway refuses): the item stays on keyword search. Nothing here ever blocks or fails a save or
 * a run: a failure is logged and the item or message is searched by keywords.
 */

/**
 * The selector waits at most this long for the query vector, then searches by keywords. The
 * embedding itself starts when the message is accepted (`prefetchQuery`, review M1), so by
 * selection it has usually answered already.
 */
export const QUERY_EMBED_DEADLINE_MS = 35;
/**
 * `recall({ query })` (KOBE-664) embeds its query when the tool is called, so it waits longer than
 * the selector (a tool call, not the run's start), still well inside the purpose's server-call
 * timeout; past it the recall answers keyword results.
 */
export const RECALL_EMBED_DEADLINE_MS = 3_000;
/** How long the Site model and pgvector state are reused before they are read again. */
export const STATE_TTL_MS = 10_000;
/** Most items embedded right after one save (an import embeds the rest with the next backfill). */
export const SAVE_EMBED_MAX = 64;

/** The query's vector and the model that made it (the selector ranks only rows of that model). */
export interface QueryVector {
  readonly model: string;
  readonly vector: readonly number[];
}

export interface QueryEmbedInput {
  readonly teamId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly message: string;
}

/** The part the selector needs (sandbox-wire delivery). */
export interface QueryEmbedder {
  /**
   * Starts this run's query embedding now (when the message is accepted, or as delivery begins),
   * without waiting; `queryVector` then takes it. Nothing for a run without memory lanes.
   */
  prefetchQuery?(input: QueryEmbedInput): void;
  /** Resolves within the deadline: the vector, or undefined (no model, no pgvector, late, error). */
  queryVector(input: QueryEmbedInput): Promise<QueryVector | undefined>;
  /**
   * `recall({ query })`'s vector (KOBE-664): embedded now, the same way and with the same token as
   * the selector's (purpose `memory_embed`, the run's member and Workspace pay, refused at 100 %
   * of a budget line), within {@link RECALL_EMBED_DEADLINE_MS}. Undefined on no model, no
   * pgvector, a refusal, an error or the deadline: never throws.
   */
  recallVector?(input: QueryEmbedInput): Promise<QueryVector | undefined>;
}

export interface SaveWho {
  readonly userId: string;
  /** The Workspace the person acts in: it pays. None: no vector (keyword search). */
  readonly teamId: string | null;
}

export interface MemoryEmbeddingsOptions {
  readonly db: KobeDb;
  /** Undefined when server calls are not configured: nothing is embedded. */
  readonly client: EmbeddingClient | undefined;
  readonly background: BackgroundTasks;
  readonly log: Pick<Logger, "info" | "warn">;
  /** The chart's in-cluster model as the gateway names it (KOBE-659), when it runs one. */
  readonly localModel?: string | undefined;
  /**
   * The process's shared LISTEN connection (KOBE-787): a Site embedding model change on any
   * replica drops this replica's cached model at once, instead of after {@link STATE_TTL_MS}.
   */
  readonly listen?: ListenClient | undefined;
  readonly queryDeadlineMs?: number;
  readonly recallDeadlineMs?: number;
  readonly now?: () => number;
}

interface Cached<T> {
  readonly value: T;
  readonly at: number;
}

const BUDGET_CODES = new Set([
  "budget_exhausted",
  "budget_below_call",
  "budget_soft_limit",
  "budget_unavailable",
]);

/** A refusal that means "this Workspace may not spend now" (logged as a skip, not a failure). */
export const isBudgetSkip = (err: unknown): boolean =>
  err instanceof ServerCallError && BUDGET_CODES.has(err.code);

const codeOf = (err: unknown) => (err instanceof ServerCallError ? err.code : "error");

export class MemoryEmbeddings implements QueryEmbedder {
  readonly localModel: string | undefined;
  readonly #o: MemoryEmbeddingsOptions;
  #model: Cached<EmbeddingModel> | undefined;
  #support: Cached<VectorSupport> | undefined;
  #modelLoad: Promise<EmbeddingModel> | undefined;
  #supportLoad: Promise<VectorSupport> | undefined;
  readonly #pending = new PendingQueries();
  /** Bumped by `invalidate`: a read begun before it stores nothing. */
  #gen = 0;
  #listening = false;

  constructor(options: MemoryEmbeddingsOptions) {
    this.#o = options;
    this.localModel = options.localModel;
  }

  /**
   * Subscribes to the setting-change hint the first time the model is read (nothing is cached
   * before that). A hint only says "read it again"; on (re)connect anything missed is re-read.
   */
  #listenOnce(): void {
    if (this.#listening || !this.#o.listen) return;
    this.#listening = true;
    this.#o.listen.subscribe(MEMORY_SETTINGS_CHANNEL, {
      notification: () => this.invalidate(),
      listening: () => this.invalidate(),
    });
  }

  get client(): EmbeddingClient | undefined {
    return this.#o.client;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  /**
   * Forget the cached model and pgvector state (the Site setting changed: on this replica, or on
   * another one through the {@link MEMORY_SETTINGS_CHANNEL} hint).
   */
  invalidate(): void {
    this.#gen += 1;
    this.#model = undefined;
    this.#support = undefined;
    this.#modelLoad = undefined;
    this.#supportLoad = undefined;
  }

  /**
   * The Site model, cached for {@link STATE_TTL_MS}. Past that the cached value is still answered
   * at once and read again in the background (review M1: no database read inside the selection's
   * window once warm); only the first read, or one after `invalidate`, waits.
   */
  async model(): Promise<EmbeddingModel> {
    this.#listenOnce();
    const cached = this.#model;
    if (cached && this.#now() - cached.at < STATE_TTL_MS) return cached.value;
    const load = (this.#modelLoad ??= this.#loadModel());
    if (cached) {
      load.catch(() => undefined);
      return cached.value;
    }
    return load;
  }

  async #loadModel(): Promise<EmbeddingModel> {
    const gen = this.#gen;
    try {
      const value = await embeddingModelFor(this.#o.db, this.localModel);
      if (gen === this.#gen) this.#model = { value, at: this.#now() };
      return value;
    } finally {
      if (gen === this.#gen) this.#modelLoad = undefined;
    }
  }

  /** pgvector's state, cached as {@link model} is. */
  async support(): Promise<VectorSupport> {
    const cached = this.#support;
    if (cached && this.#now() - cached.at < STATE_TTL_MS) return cached.value;
    const load = (this.#supportLoad ??= this.#loadSupport());
    if (cached) {
      load.catch(() => undefined);
      return cached.value;
    }
    return load;
  }

  async #loadSupport(): Promise<VectorSupport> {
    const gen = this.#gen;
    try {
      const value = await readVectorSupport(this.#o.db);
      if (gen === this.#gen) this.#support = { value, at: this.#now() };
      return value;
    } finally {
      if (gen === this.#gen) this.#supportLoad = undefined;
    }
  }

  /** The model to embed with now, or undefined (no client, no model, no columns). */
  async usableModel(): Promise<string | undefined> {
    if (!this.#o.client) return undefined;
    const [model, support] = await Promise.all([this.model(), this.support()]);
    return model.ok && support.columns ? model.model : undefined;
  }

  /**
   * Embeds the saved items' current versions in the background (never blocks or fails the save):
   * `user`/`team` items in the saver's Workspace, their own portable items, or Site items.
   */
  afterSave(who: SaveWho, scope: SemanticMemoryScope, itemIds: readonly string[]): void {
    if (who.teamId === null || itemIds.length === 0 || !this.#o.client) return;
    const teamId = who.teamId;
    this.#o.background.run(
      "memory embed on save failed",
      () => this.#embedSaved(teamId, who.userId, scope, itemIds.slice(0, SAVE_EMBED_MAX)),
      { team_id: teamId, scope },
    );
  }

  async #embedSaved(
    teamId: string,
    userId: string,
    scope: SemanticMemoryScope,
    itemIds: readonly string[],
  ): Promise<void> {
    const model = await this.usableModel();
    if (model === undefined) return;
    const table: VectorTable =
      scope === "portable" ? "portable" : scope === "site" ? "site" : "workspace";
    const pending = await withTeam(this.#o.db, teamId, (tx) =>
      pendingVersions(tx, table, {
        teamId,
        model,
        limit: SAVE_EMBED_MAX,
        itemIds,
        ...(scope === "portable" ? { ownerUserId: userId } : {}),
      }),
    );
    if (pending.length === 0) return;
    await this.embedAndStore({ teamId, userId }, table, teamId, model, pending);
  }

  /**
   * One gateway call for `pending` (≤ 64), then the vectors are stored. Returns the count stored,
   * or the refusal: `budget` (the payer's Workspace may not spend now) or another short code.
   */
  async embedAndStore(
    payer: { readonly teamId: string; readonly userId: string },
    table: VectorTable,
    rowsTeamId: string | undefined,
    model: string,
    pending: readonly {
      readonly itemId: string;
      readonly version: number;
      readonly statement: string;
    }[],
  ): Promise<{ readonly stored: number } | { readonly refused: string }> {
    const client = this.#o.client;
    if (!client) return { refused: "no_client" };
    let vectors: number[][];
    try {
      vectors = await client.embed({
        teamId: payer.teamId,
        userId: payer.userId,
        model,
        inputs: pending.map((p) => documentText(model, p.statement)),
        signal: AbortSignal.timeout(SERVER_CALL_LIMITS.memory_embed.timeout_ms),
      });
    } catch (err) {
      const budget = isBudgetSkip(err);
      this.#o.log[budget ? "info" : "warn"](
        { team_id: payer.teamId, model, code: codeOf(err), count: pending.length },
        budget ? "memory embed skipped: budget" : "memory embed failed",
      );
      return { refused: budget ? "budget" : codeOf(err) };
    }
    const rows = pending.map((p, i) => ({ ...p, vector: vectors[i] ?? [] }));
    const stored = await withTeam(this.#o.db, rowsTeamId ?? payer.teamId, (tx) =>
      writeVectors(tx, table, rowsTeamId, model, rows),
    );
    return { stored };
  }

  /** Whether this run's selection reads a memory lane (`runWantsVectors`; tests replace it). */
  runWantsVectors(input: QueryEmbedInput): Promise<boolean> {
    return runWantsVectors(this.#o.db, input);
  }

  /**
   * Starts the run's query embedding now, bounded only by the server-call timeout (review M1):
   * called when the message is accepted and again as delivery begins (once per run per process).
   * A run without memory lanes pays for nothing; its entry resolves to undefined.
   */
  prefetchQuery(input: QueryEmbedInput): void {
    if (!this.#o.client || input.message.trim() === "" || !this.#pending.canStart(input.runId)) {
      return;
    }
    const signal = AbortSignal.timeout(SERVER_CALL_LIMITS.memory_embed.timeout_ms);
    const work = (async () => {
      if (!(await this.runWantsVectors(input))) return undefined;
      return this.#embedQuery(input, signal);
    })().catch((err: unknown) => {
      this.#o.log.info(
        { run_id: input.runId, code: codeOf(err) },
        "memory query embedding failed; keyword search for this message",
      );
      return undefined;
    });
    this.#pending.put(input.runId, input.message, work);
  }

  queryVector(input: QueryEmbedInput): Promise<QueryVector | undefined> {
    const deadline = this.#o.queryDeadlineMs ?? QUERY_EMBED_DEADLINE_MS;
    // Started when the message was accepted: only wait for it (review M1).
    const early = this.#pending.take(input.runId, input.message);
    const signal = AbortSignal.timeout(deadline);
    const work =
      early ??
      this.#embedQuery(input, signal).catch((err: unknown) => {
        if (!signal.aborted) {
          this.#o.log.info(
            { run_id: input.runId, code: codeOf(err) },
            "memory query embedding failed; keyword search for this message",
          );
        }
        return undefined;
      });
    // Late answers are dropped: the selector never waits past the deadline.
    const late = new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), deadline);
      void work.finally(() => clearTimeout(timer));
    });
    return Promise.race([work, late]);
  }

  async recallVector(input: QueryEmbedInput): Promise<QueryVector | undefined> {
    if (!this.#o.client || input.message.trim() === "") return undefined;
    const deadline = Math.min(
      this.#o.recallDeadlineMs ?? RECALL_EMBED_DEADLINE_MS,
      SERVER_CALL_LIMITS.memory_embed.timeout_ms,
    );
    const signal = AbortSignal.timeout(deadline);
    const work = this.#embedQuery(input, signal).catch((err: unknown) => {
      const budget = isBudgetSkip(err);
      this.#o.log.info(
        { run_id: input.runId, code: codeOf(err) },
        budget
          ? "recall query embedding skipped: budget; keyword search"
          : "recall query embedding failed; keyword search",
      );
      return undefined;
    });
    // The model and pgvector reads are bounded too: past the deadline, keywords.
    const late = new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), deadline);
      void work.finally(() => clearTimeout(timer));
    });
    return Promise.race([work, late]);
  }

  async #embedQuery(input: QueryEmbedInput, signal: AbortSignal): Promise<QueryVector | undefined> {
    const client = this.#o.client;
    const model = await this.usableModel();
    if (!client || model === undefined || input.message.trim() === "") return undefined;
    const [vector] = await client.embed({
      teamId: input.teamId,
      userId: input.userId,
      run: { runId: input.runId, threadId: input.threadId },
      model,
      inputs: [queryText(model, input.message)],
      signal,
    });
    return vector ? { model, vector } : undefined;
  }
}
