import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  createDb,
  eq,
  and,
  isActiveRunLeasedTo,
  isRunTokenActive,
  memoryLearningPasses,
  recordRunToken,
  runs,
  sandboxRunLeases,
  threads,
  threadEntries,
  sql,
  loadGatewayPrincipal,
  modelCatalog,
  modelGatewayKeys,
  modelProviders,
  recordModelUsage,
  runUsage,
  runThinkingLevelOf,
  serverCallPassRunning,
  serverCallRunMatches,
  sandboxes,
  teamModels,
  teamMembers,
  teams,
  users,
  virtualKeyContext,
  withTeam,
  type KobeDatabase,
} from "@kobe/db";
import { RUN_TOKEN_HEADER, SERVER_CALL_AUDIENCE, SERVER_CALL_TOKEN_HEADER } from "@kobe/protocol";
import {
  generateSessionKeyPair,
  signRunToken,
  signServerCallToken,
  signSessionToken,
  verifySessionToken,
} from "@kobe/session-token";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createModelGateway } from "./gateway.js";
import { ByteBudget, CallLimiter, RequestRate } from "./limits.js";
import { PrincipalCache } from "./principals.js";
import { OPEN_GATE, type CallRecord } from "./seams.js";
import { ServerCallReplay } from "./server-call.js";
import { usageRecordOf } from "./usage/sink.js";

/**
 * KOBE-40 ac-2 at integration level: the shim with its real Postgres principal store. A live
 * member's sandbox token reaches Bifrost (faked) with the member's sealed virtual key; once the
 * member is removed, deactivated, or the sandbox destroyed, the same (still unexpired) token is
 * refused.
 */
const SESSION = generateSessionKeyPair();
const box = new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE);
const team = randomUUID();
const other = randomUUID();
const user = randomUUID();
const sandboxId = randomUUID();
const VK = `sk-bf-${randomUUID()}`;
let app: KobeDatabase;
let bifrost: Server;
let shim: Server;
let base = "";
const seenVks: string[] = [];
const seenBodies: string[] = [];
const RUN_KEY = SESSION.signing;
let requireRunToken = false;
const SC_KEY = SESSION.signing;
const recorded: CallRecord[] = [];

const token = (teamId = team) => {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: "kobe.model-gateway",
      sub: sandboxId,
      team_id: teamId,
      user_id: user,
      iat: now,
      exp: now + 900,
      jti: randomUUID().replace(/-/g, ""),
    },
    SESSION.signing,
  );
};
const chat = (t: string) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-x", messages: [] }),
  }).then((r) => r.status);

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: team, slug: `g-${team.slice(0, 8)}`, name: "Gateway" },
    { id: other, slug: `o-${other.slice(0, 8)}`, name: "Other" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: user, name: "G", email: `${user}@g.test` });
  await app.db
    .insert(modelProviders)
    .values({ id: "openai", kind: "openai", name: "OpenAI", apiKeyEnc: "v2.x", createdBy: user })
    .onConflictDoNothing();
  await app.db.insert(modelCatalog).values({
    alias: `fast-${team.slice(0, 8)}`,
    providerId: "openai",
    model: "gpt-x",
    createdBy: user,
  });
  await withTeam(app.db, team, async (tx) => {
    await tx.insert(teamMembers).values({ teamId: team, userId: user, role: "member" });
    await tx.insert(sandboxes).values({ teamId: team, userId: user, sandboxId, state: "running" });
    await tx
      .insert(teamModels)
      .values({ teamId: team, alias: `fast-${team.slice(0, 8)}`, enabledBy: user });
    await tx.insert(modelGatewayKeys).values({
      teamId: team,
      userId: user,
      vkId: "vk-1",
      vkValueEnc: box.seal(VK, virtualKeyContext(team, user)),
    });
  });
  bifrost = createServer((req, res) => {
    seenVks.push(String(req.headers["x-bf-vk"]));
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seenBodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => bifrost.listen(0, "127.0.0.1", r));
  const db = app.db;
  shim = createModelGateway({
    verify: (t) => verifySessionToken(t, "kobe.model-gateway", SESSION.verify),
    runTokens: {
      keys: SESSION.verify,
      isActive: (s) => isRunTokenActive(db, s),
      get require() {
        return requireRunToken;
      },
    },
    principals: new PrincipalCache(
      {
        load: (t, u, s) => loadGatewayPrincipal(db, t, u, s),
        requestKey: async () => undefined,
      },
      box,
      { ttlMs: 0, keyWaitMs: 100, keyPollMs: 20 },
    ),
    isRunLeased: (t, r, s) => isActiveRunLeasedTo(db, t, r, s),
    runThinking: (t, r) => runThinkingLevelOf(db, t, r),
    serverCalls: {
      keys: SESSION.verify,
      replay: new ServerCallReplay(),
      runMatches: (c) => serverCallRunMatches(db, c),
      passRunning: (c) => serverCallPassRunning(db, c),
      limiter: new CallLimiter({ perSandbox: 2, total: 4 }),
      rate: new RequestRate({ burst: 10, perSecond: 10 }),
    },
    bifrostUrl: `http://127.0.0.1:${(bifrost.address() as AddressInfo).port}`,
    limiter: new CallLimiter({ perSandbox: 4, total: 16 }),
    bytes: new ByteBudget({ perSandbox: 65_536, total: 65_536 }),
    rate: new RequestRate({ burst: 100, perSecond: 100 }),
    gate: OPEN_GATE,
    sink: { record: (r) => recorded.push(r) },
    onBifrostForgotKey: () => undefined,
    logger: pino({ level: "silent" }),
    settings: { maxBodyBytes: 65_536, idleTimeoutMs: 5_000 },
    ready: () => true,
  });
  await new Promise<void>((r) => shim.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(shim.address() as AddressInfo).port}`;
});
afterAll(async () => {
  shim.closeAllConnections();
  await new Promise<void>((r) => shim.close(() => r()));
  await new Promise<void>((r) => bifrost.close(() => r()));
  await app.close();
});

describe("model gateway with its Postgres principal store", () => {
  it("a live member's sandbox token reaches Bifrost with the member's virtual key", async () => {
    expect(await chat(token())).toBe(200);
    expect(seenVks).toEqual([VK]);
  });

  it("a model the team disabled is refused by the shim itself (even if Bifrost lags)", async () => {
    await withTeam(app.db, team, (tx) => tx.delete(teamModels).where(eq(teamModels.teamId, team)));
    expect(await chat(token())).toBe(403);
    await withTeam(app.db, team, (tx) =>
      tx
        .insert(teamModels)
        .values({ teamId: team, alias: `fast-${team.slice(0, 8)}`, enabledBy: user }),
    );
    expect(await chat(token())).toBe(200);
    expect(seenVks).toEqual([VK, VK]);
  });

  it("writes the run's recorded thinking level, clamped to the catalog and team, into each call (KOBE-260)", async () => {
    const alias = `fast-${team.slice(0, 8)}`;
    const vksBefore = seenVks.length;
    await app.db.execute(sql`UPDATE model_catalog SET reasoning = true,
      thinking_control = 'reasoning_effort', thinking_allowed = true, thinking_default = 'low',
      thinking_max = 'medium' WHERE alias = ${alias}`);
    try {
      const runId = await withTeam(app.db, team, async (tx) => {
        const [thread] = await tx
          .insert(threads)
          .values({ teamId: team, ownerUserId: user, thinkingLevel: "high" })
          .returning({ id: threads.id });
        const [run] = await tx
          .insert(runs)
          .values({
            teamId: team,
            threadId: thread?.id ?? "",
            trigger: "user",
            status: "running",
            startedAt: new Date(),
            thinkingLevel: "high",
          })
          .returning({ id: runs.id });
        await tx.insert(sandboxRunLeases).values({
          teamId: team,
          runId: run?.id ?? "",
          userId: user,
          threadId: thread?.id ?? "",
          sandboxId,
        });
        return run?.id ?? "";
      });
      const send = async (extra: Record<string, unknown>, run?: string) => {
        const r = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token()}`,
            "content-type": "application/json",
            ...(run ? { "x-kobe-run-id": run } : {}),
          },
          body: JSON.stringify({ model: "openai/gpt-x", messages: [], ...extra }),
        });
        expect(r.status).toBe(200);
        return JSON.parse(seenBodies.at(-1) ?? "{}") as Record<string, unknown>;
      };
      // The run recorded high; the site's maximum is medium; the sandbox asks for high.
      expect((await send({ reasoning_effort: "high" }, runId)).reasoning_effort).toBe("medium");
      // The team lowers it: the next call follows.
      await withTeam(app.db, team, (tx) =>
        tx.update(teamModels).set({ thinkingMax: "off" }).where(eq(teamModels.alias, alias)),
      );
      expect((await send({ reasoning_effort: "high" }, runId)).reasoning_effort).toBe("none");
      // A call that names no run gets the model's default (here clamped by the team: off).
      expect((await send({})).reasoning_effort).toBe("none");
    } finally {
      // The later revocation test counts the calls that reached Bifrost.
      seenVks.splice(vksBefore);
      await withTeam(app.db, team, (tx) =>
        tx.update(teamModels).set({ thinkingMax: null }).where(eq(teamModels.alias, alias)),
      );
      await app.db.execute(sql`UPDATE model_catalog SET thinking_control = 'none',
        thinking_allowed = false, thinking_default = NULL, thinking_max = NULL, reasoning = false
        WHERE alias = ${alias}`);
    }
  });

  it("a token naming another team (where the user is no member) is refused", async () => {
    expect(await chat(token(other))).toBe(401);
  });

  it("revocation: hibernated or destroyed sandbox, removed member — the same token stops", async () => {
    const t = token();
    const setState = (state: "running" | "hibernated") =>
      withTeam(app.db, team, (tx) =>
        tx
          .update(sandboxes)
          .set({ state })
          .where(and(eq(sandboxes.teamId, team), eq(sandboxes.userId, user))),
      );
    await setState("hibernated");
    expect(await chat(t)).toBe(401);
    await setState("running");
    expect(await chat(t)).toBe(200);
    await withTeam(app.db, team, (tx) =>
      tx.delete(teamMembers).where(and(eq(teamMembers.teamId, team), eq(teamMembers.userId, user))),
    );
    expect(await chat(t)).toBe(401);
    expect(seenVks).toHaveLength(3);
  });
});

describe("run tokens against the real record (KOBE-118)", () => {
  it("a real run end revokes the token: 200 while active, 403 after, 401 without a token when enforced", async () => {
    const runId = await withTeam(app.db, team, async (tx) => {
      // The previous test removed the member: put it back.
      await tx.insert(teamMembers).values({ teamId: team, userId: user, role: "member" });
      const [thread] = await tx
        .insert(threads)
        .values({ teamId: team, ownerUserId: user })
        .returning({ id: threads.id });
      const [run] = await tx
        .insert(runs)
        .values({
          teamId: team,
          threadId: thread?.id ?? "",
          trigger: "user",
          status: "running",
          startedAt: new Date(),
        })
        .returning({ id: runs.id });
      await tx.insert(sandboxRunLeases).values({
        teamId: team,
        runId: run?.id ?? "",
        userId: user,
        threadId: thread?.id ?? "",
        sandboxId,
      });
      return run?.id ?? "";
    });
    const jti = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    await withTeam(app.db, team, (tx) =>
      recordRunToken(tx, {
        teamId: team,
        jti,
        runId,
        sandboxId,
        expiresAt: new Date((iat + 600) * 1000),
      }),
    );
    const grant = signRunToken(RUN_KEY, {
      iss: "kobe-server",
      aud: "kobe.model-gateway",
      run_id: runId,
      team_id: team,
      sandbox_id: sandboxId,
      iat,
      exp: iat + 600,
      jti,
    });
    const call = (headers: Record<string, string>) =>
      fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token()}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ model: "openai/gpt-x", messages: [] }),
      }).then((r) => r.status);
    expect(await call({ [RUN_TOKEN_HEADER]: grant.token })).toBe(200);
    // The run ends the way every path ends it: its status leaves the active set.
    await withTeam(app.db, team, (tx) =>
      tx.execute(
        sql`UPDATE runs SET status = 'cancelled', ended_at = now() WHERE team_id = ${team} AND id = ${runId}`,
      ),
    );
    expect(await call({ [RUN_TOKEN_HEADER]: grant.token })).toBe(403);
    requireRunToken = true;
    try {
      expect(await call({})).toBe(401);
      expect(await call({ "x-kobe-run-id": runId })).toBe(401);
    } finally {
      requireRunToken = false;
    }
  });
});

describe("server calls against the real store and ledger (KOBE-234)", () => {
  it("a title call reaches Bifrost without a live sandbox and lands as a kind=title row", async () => {
    const { runId, threadId } = await withTeam(app.db, team, async (tx) => {
      const [thread] = await tx
        .insert(threads)
        .values({ teamId: team, ownerUserId: user })
        .returning({ id: threads.id });
      const [run] = await tx
        .insert(runs)
        .values({
          teamId: team,
          threadId: thread?.id ?? "",
          trigger: "user",
          status: "completed",
          startedAt: new Date(),
          endedAt: new Date(),
        })
        .returning({ id: runs.id });
      await tx.insert(sandboxRunLeases).values({
        teamId: team,
        runId: run?.id ?? "",
        userId: user,
        threadId: thread?.id ?? "",
        sandboxId,
      });
      // The member's sandbox hibernated after the run: a server call does not need it.
      await tx
        .update(sandboxes)
        .set({ state: "hibernated" })
        .where(and(eq(sandboxes.teamId, team), eq(sandboxes.userId, user)));
      return { runId: run?.id ?? "", threadId: thread?.id ?? "" };
    });
    const iat = Math.floor(Date.now() / 1000);
    const scToken = signServerCallToken(SC_KEY, {
      iss: "kobe-server",
      aud: SERVER_CALL_AUDIENCE,
      purpose: "title",
      team_id: team,
      user_id: user,
      thread_id: threadId,
      run_id: runId,
      model: "openai/gpt-x",
      max_output_tokens: 32,
      iat,
      exp: iat + 30,
      jti: randomUUID(),
    });
    // Review L1: a token naming another member (or thread) for that run is refused.
    const mate = randomUUID();
    await app.db.insert(users).values({ id: mate, name: "O", email: `${mate}@g.test` });
    await withTeam(app.db, team, (tx) =>
      tx.insert(teamMembers).values({ teamId: team, userId: mate, role: "member" }),
    );
    expect(
      await serverCallRunMatches(app.db, { teamId: team, runId, threadId, userId: mate }),
    ).toBe(false);
    expect(
      await serverCallRunMatches(app.db, {
        teamId: team,
        runId,
        threadId: randomUUID(),
        userId: user,
      }),
    ).toBe(false);
    expect(
      await serverCallRunMatches(app.db, { teamId: other, runId, threadId, userId: user }),
    ).toBe(false);
    expect(
      await serverCallRunMatches(app.db, { teamId: team, runId, threadId, userId: user }),
    ).toBe(true);
    const before = seenVks.length;
    recorded.length = 0;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { [SERVER_CALL_TOKEN_HEADER]: scToken, "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-x",
        messages: [{ role: "user", content: "Title: revenue by region" }],
        max_tokens: 32,
      }),
    });
    expect(res.status).toBe(200);
    expect(seenVks.slice(before)).toEqual([VK]);
    // The sandbox path still refuses that hibernated sandbox's token.
    expect(await chat(token())).toBe(401);
    await expect.poll(() => recorded.length).toBe(1);
    const row = usageRecordOf(recorded[0] as CallRecord);
    expect(row).toBeDefined();
    await recordModelUsage(app.db, row ? [row] : []);
    const [stored] = await withTeam(app.db, team, (tx) =>
      tx
        .select()
        .from(runUsage)
        .where(eq(runUsage.id, row?.id ?? "")),
    );
    expect(stored).toMatchObject({ kind: "title", sandboxId: null, runId, threadId, userId: user });
  });

  it("a live-run claim (KOBE-409 memory_embed) takes an unfinished run, never a failed one", async () => {
    const make = (status: "running" | "completed" | "failed" | "cancelled", leased = true) =>
      withTeam(app.db, team, async (tx) => {
        const [thread] = await tx
          .insert(threads)
          .values({ teamId: team, ownerUserId: user })
          .returning({ id: threads.id });
        const ended = status !== "running";
        const [run] = await tx
          .insert(runs)
          .values({
            teamId: team,
            threadId: thread?.id ?? "",
            trigger: "user",
            status,
            startedAt: new Date(),
            ...(ended ? { endedAt: new Date() } : {}),
          })
          .returning({ id: runs.id });
        if (leased) {
          await tx.insert(sandboxRunLeases).values({
            teamId: team,
            runId: run?.id ?? "",
            userId: user,
            threadId: thread?.id ?? "",
            sandboxId,
          });
        }
        return { teamId: team, runId: run?.id ?? "", threadId: thread?.id ?? "", userId: user };
      });
    const running = await make("running");
    expect(await serverCallRunMatches(app.db, running)).toBe(false);
    expect(await serverCallRunMatches(app.db, { ...running, live: true })).toBe(true);
    expect(await serverCallRunMatches(app.db, { ...(await make("completed")), live: true })).toBe(
      true,
    );
    for (const status of ["failed", "cancelled"] as const) {
      expect(await serverCallRunMatches(app.db, { ...(await make(status)), live: true })).toBe(
        false,
      );
    }
    expect(
      await serverCallRunMatches(app.db, { ...running, userId: randomUUID(), live: true }),
    ).toBe(false);
    // Review M1: the query embedding starts when the message is accepted, before any sandbox
    // took the run (no lease yet): the thread's owner (whose sandbox runs it) is the member.
    const unleased = await make("running", false);
    expect(await serverCallRunMatches(app.db, { ...unleased, live: true })).toBe(true);
    expect(await serverCallRunMatches(app.db, unleased)).toBe(false);
    expect(
      await serverCallRunMatches(app.db, { ...unleased, userId: randomUUID(), live: true }),
    ).toBe(false);
    expect(
      await serverCallRunMatches(app.db, { ...unleased, threadId: randomUUID(), live: true }),
    ).toBe(false);
  });
});

describe("a learning pass's call against the real store (KOBE-391)", () => {
  /** A thread `user` wrote, shared with `mate`: one completed run leased to each of them. */
  async function sharedThread() {
    const mate = randomUUID();
    await app.db.insert(users).values({ id: mate, name: "M", email: `${mate}@g.test` });
    return withTeam(app.db, team, async (tx) => {
      await tx.insert(teamMembers).values({ teamId: team, userId: mate, role: "member" });
      const [thread] = await tx
        .insert(threads)
        .values({ teamId: team, ownerUserId: user })
        .returning({ id: threads.id });
      const threadId = thread?.id ?? "";
      await tx
        .insert(threadEntries)
        .values({ teamId: team, threadId, entryId: "leaf", type: "message" });
      const runOf = async (who: string) => {
        const [r] = await tx
          .insert(runs)
          .values({
            teamId: team,
            threadId,
            trigger: "user",
            status: "completed",
            startedAt: new Date(),
            endedAt: new Date(),
          })
          .returning({ id: runs.id });
        await tx
          .insert(sandboxRunLeases)
          .values({ teamId: team, runId: r?.id ?? "", userId: who, threadId, sandboxId });
        return r?.id ?? "";
      };
      return { mate, threadId, authorRun: await runOf(user), mateRun: await runOf(mate) };
    });
  }

  /** A learning pass of `who` over `threadId` in `status` (finished ones carry their end). */
  async function passOf(threadId: string, who: string, status: "running" | "completed" | "failed") {
    const finished =
      status === "running"
        ? {}
        : {
            finishedAt: new Date(),
            toEntryId: "leaf",
            ...(status === "failed" ? { error: "x" } : {}),
          };
    const [p] = await withTeam(app.db, team, (tx) =>
      tx
        .insert(memoryLearningPasses)
        .values({
          teamId: team,
          threadId,
          userId: who,
          branchLeafEntryId: "leaf",
          modelAlias: "learner",
          promptVersion: "v1",
          status,
          startedAt: new Date(),
          ...finished,
        })
        .returning({ id: memoryLearningPasses.id }),
    );
    return p?.id ?? "";
  }

  it("the pass check admits a running pass of the token's thread and member only", async () => {
    const { mate, threadId } = await sharedThread();
    const { threadId: otherThread } = await sharedThread();
    const claim = (passId: string, userId = user, thread = threadId) => ({
      teamId: team,
      passId,
      threadId: thread,
      userId,
    });
    const running = await passOf(threadId, user, "running");
    expect(await serverCallPassRunning(app.db, claim(running))).toBe(true);
    // Wrong pass: an unknown id, or the right id named on another thread.
    expect(await serverCallPassRunning(app.db, claim(randomUUID()))).toBe(false);
    expect(await serverCallPassRunning(app.db, claim(running, user, otherThread))).toBe(false);
    // Another member's pass (the mate's, on a thread of their own).
    expect(await serverCallPassRunning(app.db, claim(running, mate))).toBe(false);
    const matePass = await passOf(otherThread, mate, "running");
    expect(await serverCallPassRunning(app.db, claim(matePass, user, otherThread))).toBe(false);
    // Finished passes: completed or failed.
    await withTeam(app.db, team, (tx) =>
      tx
        .update(memoryLearningPasses)
        .set({ status: "completed", finishedAt: new Date(), toEntryId: "leaf" })
        .where(and(eq(memoryLearningPasses.teamId, team), eq(memoryLearningPasses.id, running))),
    );
    expect(await serverCallPassRunning(app.db, claim(running))).toBe(false);
    const failed = await passOf(threadId, user, "failed");
    expect(await serverCallPassRunning(app.db, claim(failed))).toBe(false);
    // Another team never sees the pass.
    expect(
      await serverCallPassRunning(app.db, { ...claim(matePass, mate, otherThread), teamId: other }),
    ).toBe(false);
  });

  it("the run check admits the thread's author only (ac-2)", async () => {
    const { mate, threadId, authorRun, mateRun } = await sharedThread();
    const claim = (runId: string, userId: string) => ({ teamId: team, runId, threadId, userId });
    // A title or follow-ups call for the member who ran it, as before.
    expect(await serverCallRunMatches(app.db, claim(mateRun, mate))).toBe(true);
    // A learning pass: not for a member who is not the author, even on their own run.
    expect(await serverCallRunMatches(app.db, { ...claim(mateRun, mate), authorOnly: true })).toBe(
      false,
    );
    expect(await serverCallRunMatches(app.db, { ...claim(mateRun, user), authorOnly: true })).toBe(
      false,
    );
    expect(
      await serverCallRunMatches(app.db, { ...claim(authorRun, user), authorOnly: true }),
    ).toBe(true);
  });

  it("reads the catalog's maxOutputTokens for a server call (output clamp)", async () => {
    const alias = `fast-${team.slice(0, 8)}`;
    await app.db
      .update(modelCatalog)
      .set({ maxOutputTokens: 4096 })
      .where(eq(modelCatalog.alias, alias));
    try {
      const p = await loadGatewayPrincipal(app.db, team, user, undefined);
      expect(p.outputCaps).toEqual({ "openai/gpt-x": 4096 });
    } finally {
      await app.db
        .update(modelCatalog)
        .set({ maxOutputTokens: null })
        .where(eq(modelCatalog.alias, alias));
    }
    expect((await loadGatewayPrincipal(app.db, team, user, undefined)).outputCaps).toEqual({});
  });

  it("an author's extractor call reaches Bifrost and lands as a kind=memory_learn row", async () => {
    const { threadId, authorRun } = await sharedThread();
    const passId = await passOf(threadId, user, "running");
    const learnCall = async (pass: string) => {
      const iat = Math.floor(Date.now() / 1000);
      const scToken = signServerCallToken(SC_KEY, {
        iss: "kobe-server",
        aud: SERVER_CALL_AUDIENCE,
        purpose: "memory_learn",
        team_id: team,
        user_id: user,
        thread_id: threadId,
        run_id: authorRun,
        pass_id: pass,
        model: "openai/gpt-x",
        max_output_tokens: 8192,
        iat,
        exp: iat + 30,
        jti: randomUUID(),
      });
      return fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { [SERVER_CALL_TOKEN_HEADER]: scToken, "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-x",
          messages: [{ role: "user", content: "the thread" }],
          max_tokens: 8192,
          temperature: 0,
        }),
      });
    };
    recorded.length = 0;
    // A pass that is not running (here: an unknown id) is refused before Bifrost.
    const refused = await learnCall(randomUUID());
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error?: { code?: string } }).error?.code).toBe(
      "server_call_pass_mismatch",
    );
    const res = await learnCall(passId);
    expect(res.status).toBe(200);
    await expect.poll(() => recorded.length).toBe(1);
    const row = usageRecordOf(recorded[0] as CallRecord);
    expect(row).toBeDefined();
    await recordModelUsage(app.db, row ? [row] : []);
    const [stored] = await withTeam(app.db, team, (tx) =>
      tx
        .select()
        .from(runUsage)
        .where(eq(runUsage.id, row?.id ?? "")),
    );
    expect(stored).toMatchObject({
      kind: "memory_learn",
      sandboxId: null,
      runId: authorRun,
      threadId,
      userId: user,
    });
  });
});
