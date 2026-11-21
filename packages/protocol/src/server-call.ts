import { z } from "zod";
import { NO_CONTROL_CHARS, THREAD_TITLE_MAX, uuidSchema } from "./common.js";
import { gatewayModelSchema } from "./sandbox-wire/frames/model.js";
import {
  MEMORY_EMBED_MAX_INPUT_CHARS,
  SERVER_CALL_EMBEDDINGS_PATH,
} from "./server-call-embeddings.js";
import {
  MEMORY_EXTRACTOR_RESPONSE_SCHEMA,
  MEMORY_LEARN_SCHEMA_RETRIES,
} from "./semantic-memory/learning.js";
import { SKILL_EVAL_JUDGE_RESPONSE_SCHEMA } from "./skill-evals/judge.js";

/**
 * Server-originated model calls (KOBE-234; CE18 auto-titles, CE21 follow-ups). After a run
 * completes, the server itself asks the thread's model for a title or three follow-ups. No sandbox
 * and no active run exist, so neither the session token nor the run token (run-token.ts) applies.
 * Design and rationale: docs/design/server-model-calls.md.
 *
 * Identity: a **server-call token**, minted by the server per call and sent to the model gateway in
 * the {@link SERVER_CALL_TOKEN_HEADER} header, alone (no session token, run token or advisory run
 * id on the same request). Format (KOBE-521): a compact JWS signed **EdDSA (Ed25519)** by the
 * server with the `kobe.model-gateway` session-token key pair, header exactly
 * `{"alg":"EdDSA","typ":"ksc2","kid":"<key id>"}` ({@link SERVER_CALL_TOKEN_TYP}), payload the
 * UTF-8 JSON of {@link ServerCallClaims}. The signed `typ` and the audience keep it apart from
 * session tokens (`JWT`) and run tokens (`krt2`) under the same key. The gateway holds the public
 * key(s) only, so it verifies server-call tokens but cannot mint one. Sandboxes hold no key and
 * never see a server-call token. (`ksc1`, HMAC with a key derived from a secret the gateway shared
 * with the server, is refused since KOBE-521.)
 *
 * The gateway (every request): size cap, header, Ed25519 signature, strict claims, `now < exp`,
 * `iat <= now + skew`, the `jti` not seen before on this replica (single use per replica; across
 * replicas the token is bounded by its TTL, purpose, model and output cap; threat model in the
 * design doc), the member still active with a virtual key, the token's run a completed run of its
 * thread leased to its member, `model` enabled for the team, and then the body:
 * {@link serverCallRequestSchema} (Chat Completions, no tools, no streaming), `body.model ===
 * claims.model`, its output limit at most `claims.max_output_tokens`. Budgets are the same
 * reservation path as sandbox calls (`kobe_reserve_budget`, KOBE-120/286) for (team, user), plus
 * {@link SERVER_CALL_LIMITS}`[purpose].skip_at_percent`, which the gateway enforces too (402
 * `budget_soft_limit`; judged by the reservation at that percentage of each line), so a server
 * bug cannot spend past the rule. Usage is one `run_usage` row
 * with `kind = purpose`, no sandbox, `run_id = claims.run_id` (migration 0099).
 *
 * Purposes: the post-run **epilogue** ({@link SERVER_CALL_PURPOSES}: titles, follow-ups, announced
 * in `run.completed.epilogue`), and the skill eval judge (`eval_judge`, KOBE-326, SK17: one call
 * per judged eval execution after its run completed, recorded as `run_usage.kind = eval_judge`).
 * A token carries any of {@link SERVER_CALL_TOKEN_PURPOSES}; only the epilogue's are announced.
 */
export const SERVER_CALL_PURPOSES = ["title", "followups"] as const;
export const serverCallPurposeSchema = z.enum(SERVER_CALL_PURPOSES);
/** An epilogue purpose (what `run.completed.epilogue` may announce). */
export type ServerCallPurpose = z.infer<typeof serverCallPurposeSchema>;
/**
 * Every purpose a server-call token may carry: the epilogue's, the eval judge's, and the skill
 * manifest's (`skill_manifest`, KOBE-564: a member asks Kobe to write a version's
 * `kobe.skill.yaml` with the model they chose; the only purpose a member starts, so it names no
 * thread or run: {@link RUNLESS_SERVER_CALL_PURPOSES}), and the learning pass's (`memory_learn`,
 * KOBE-390, SM14/SM15: one extractor call per pass, bound to the leaf's last completed run and
 * naming its pass in `pass_id`; semantic-memory/learning.ts), and the embedding calls
 * (`memory_embed`, KOBE-409: `POST /v1/embeddings` only, server-call-embeddings.ts; the run is
 * optional: {@link OPTIONAL_RUN_SERVER_CALL_PURPOSES}). Append new purposes at the end, each
 * with its `SERVER_CALL_LIMITS` entry (the compiler insists) and, if it asks for structured output,
 * a `SERVER_CALL_RESPONSE_FORMATS` entry.
 */
export const SERVER_CALL_TOKEN_PURPOSES = [
  ...SERVER_CALL_PURPOSES,
  "eval_judge",
  "skill_manifest",
  "memory_learn",
  "memory_embed",
] as const;
export const serverCallTokenPurposeSchema = z.enum(SERVER_CALL_TOKEN_PURPOSES);
export type ServerCallTokenPurpose = z.infer<typeof serverCallTokenPurposeSchema>;

/**
 * Purposes a member starts from the UI rather than a completed run (KOBE-564): their token names
 * no `thread_id` or `run_id`, the gateway skips the run check, and the usage row has a NULL
 * `run_id` (its `kind` is the purpose). Every other purpose is bound to a completed run.
 */
export const RUNLESS_SERVER_CALL_PURPOSES = ["skill_manifest"] as const;
export type RunlessServerCallPurpose = (typeof RUNLESS_SERVER_CALL_PURPOSES)[number];

/**
 * Purposes whose token may name a run (and its thread) or none (KOBE-409 `memory_embed`): the
 * selector's query embedding names the run being started (not yet completed, so the gateway's
 * completed-run check does not apply: the ids are usage attribution only); saves and background
 * jobs name none. The budget is always the token's (team, user).
 */
export const OPTIONAL_RUN_SERVER_CALL_PURPOSES = ["memory_embed"] as const;

/** Whether a purpose's run ids are optional attribution (never checked against a completed run). */
export function serverCallRunOptional(purpose: ServerCallTokenPurpose): boolean {
  return (OPTIONAL_RUN_SERVER_CALL_PURPOSES as readonly string[]).includes(purpose);
}

/** Whether a purpose's token must name the completed run (and thread) that triggered the call. */
export function serverCallBoundToRun(purpose: ServerCallTokenPurpose): boolean {
  return (
    !(RUNLESS_SERVER_CALL_PURPOSES as readonly string[]).includes(purpose) &&
    !serverCallRunOptional(purpose)
  );
}

export const SERVER_CALL_TOKEN_HEADER = "x-kobe-server-call";
/** The signed JWS `typ` of a server-call token (KOBE-521): never `JWT` or `krt2`. */
export const SERVER_CALL_TOKEN_TYP = "ksc2";
/** The audience no other Kobe token carries (session and run tokens say `kobe.model-gateway`). */
export const SERVER_CALL_AUDIENCE = "kobe.model-gateway.server-call";
/**
 * Longest token any verifier reads; larger input is rejected before parsing. 1280 since KOBE-521
 * (was 1024): the Ed25519 JWS adds a header and a longer signature, and every claims set the
 * contract allows (256-char model, 128-char `jti`) must still fit.
 */
export const SERVER_CALL_TOKEN_MAX_CHARS = 1280;
/** Tolerated clock skew for `iat`, seconds. */
export const SERVER_CALL_TOKEN_SKEW_SECONDS = 30;
/** Upper bound on `exp - iat`: a token is minted right before its one call. */
export const MAX_SERVER_CALL_TOKEN_TTL_SECONDS = 30;
/** The gateway route of every chat server call (Bifrost translates it for every provider). */
export const SERVER_CALL_PATH = "/v1/chat/completions";

/** The one route a purpose's token may use: embeddings for `memory_embed`, chat for the rest. */
export function serverCallPathFor(purpose: ServerCallTokenPurpose): string {
  return purpose === "memory_embed" ? SERVER_CALL_EMBEDDINGS_PATH : SERVER_CALL_PATH;
}
/** Largest request body the gateway accepts on an epilogue call (`SERVER_CALL_LIMITS` per purpose). */
export const SERVER_CALL_MAX_BODY_BYTES = 64 * 1024;
export const SERVER_CALL_MAX_MESSAGES = 4;
/** Longest message text of an epilogue call, in UTF-16 code units (the server truncates). */
export const SERVER_CALL_MESSAGE_MAX_CHARS = 16_000;

/**
 * Per purpose: the hard output cap (the gateway refuses more whatever the token says), the cap
 * for a model the site catalog marks as reasoning (`model_catalog.reasoning`, KOBE-259): its
 * hidden reasoning spends the same allowance, so 64 tokens can leave no visible text (KOBE-219
 * review H1); the gateway allows it only for such a model. Then the server's whole-call timeout
 * (no retries; a failure is logged, never a run failure), and the budget use at which the call is
 * skipped: titles below 100 % (the ordinary budget stop), follow-ups below 80 % (CE21). Percent
 * of every budget line that applies to the call (site, team, user-in-team; dollars or tokens;
 * month or day). The visible text is bounded by its own schema whatever the cap. Then the body:
 * the longest message (UTF-16 code units) and body the gateway accepts for the purpose, and the
 * temperature the server asks for.
 *
 * The eval judge (KOBE-326): its data is a case's prompt, final answer (64 Ki characters) and the
 * matched outputs' text (64 Ki characters in all) as escaped JSON, so its messages and body are
 * larger; temperature 0 (the author's run and the Registry re-run should agree); a verdict is a
 * boolean and one or two sentences; the call has its own timeout (the eval runner keeps beating
 * meanwhile, and nobody else ends a beating execution).
 */
/** One purpose's limits (see {@link SERVER_CALL_LIMITS}); the gateway reads these per token. */
export interface ServerCallLimit {
  readonly max_output_tokens: number;
  readonly reasoning_max_output_tokens: number;
  readonly timeout_ms: number;
  readonly skip_at_percent: number;
  readonly max_message_chars: number;
  readonly max_body_bytes: number;
  readonly temperature: number;
}

export const SERVER_CALL_LIMITS = {
  title: {
    max_output_tokens: 64,
    reasoning_max_output_tokens: 512,
    timeout_ms: 15_000,
    skip_at_percent: 100,
    max_message_chars: SERVER_CALL_MESSAGE_MAX_CHARS,
    max_body_bytes: SERVER_CALL_MAX_BODY_BYTES,
    temperature: 0.2,
  },
  followups: {
    max_output_tokens: 256,
    reasoning_max_output_tokens: 768,
    timeout_ms: 20_000,
    skip_at_percent: 80,
    max_message_chars: SERVER_CALL_MESSAGE_MAX_CHARS,
    max_body_bytes: SERVER_CALL_MAX_BODY_BYTES,
    temperature: 0.2,
  },
  eval_judge: {
    max_output_tokens: 512,
    reasoning_max_output_tokens: 2048,
    timeout_ms: 60_000,
    skip_at_percent: 100,
    max_message_chars: 400_000,
    max_body_bytes: 2 * 1024 * 1024,
    temperature: 0,
  },
  // KOBE-564: a `kobe.skill.yaml` drafted from SKILL.md (up to 100 KiB) and the file list; the
  // answer is one small JSON object (summary, tags, capabilities), so the output cap is modest.
  skill_manifest: {
    max_output_tokens: 1024,
    reasoning_max_output_tokens: 3072,
    timeout_ms: 60_000,
    skip_at_percent: 100,
    max_message_chars: 120_000,
    max_body_bytes: 512 * 1024,
    temperature: 0.2,
  },
  // KOBE-390 (SM14/SM15): the learning pass's extractor. Its data is the thread up to the leaf
  // (one message of up to 300,000 characters) plus the Workspace's related items; its answer is up
  // to 20 candidates with evidence, so the output is the largest of any purpose. The server clamps
  // the cap to the model's catalog `maxOutputTokens` ({@link serverCallOutputCapFor}). Temperature
  // 0 (extraction, not prose); refused at 100 % of a budget line; a 30 s token like every purpose
  // with a 60 s call timeout; one retry on a schema reject (MEMORY_LEARN_SCHEMA_RETRIES).
  memory_learn: {
    max_output_tokens: 8192,
    reasoning_max_output_tokens: 16_384,
    timeout_ms: 60_000,
    skip_at_percent: 100,
    max_message_chars: 300_000,
    max_body_bytes: 384 * 1024,
    temperature: 0,
  },
  // KOBE-409: embeddings generate no text (the output caps are the schema's minimum and the
  // reservation's allowance only); each input at most MEMORY_EMBED_MAX_INPUT_CHARS, a backfill
  // batch of up to 64 statements fits the body. A short timeout: the selector gives the query
  // embedding its own, shorter deadline and falls back to keyword search.
  memory_embed: {
    max_output_tokens: 1,
    reasoning_max_output_tokens: 1,
    timeout_ms: 15_000,
    skip_at_percent: 100,
    max_message_chars: MEMORY_EMBED_MAX_INPUT_CHARS,
    max_body_bytes: 384 * 1024,
    temperature: 0,
  },
} as const satisfies Record<ServerCallTokenPurpose, ServerCallLimit>;

/** Longest message any server call may send (each purpose's own cap is checked too). */
const MAX_MESSAGE_CHARS = Math.max(
  ...SERVER_CALL_TOKEN_PURPOSES.map((p) => SERVER_CALL_LIMITS[p].max_message_chars),
);

/**
 * The structured-output format a purpose may ask for (`response_format`), exactly this one: the
 * eval judge's verdict schema (KOBE-324 `SKILL_EVAL_JUDGE_RESPONSE_SCHEMA`) and the learning
 * pass's extractor schema (KOBE-390 `MEMORY_EXTRACTOR_RESPONSE_SCHEMA`). Other purposes send
 * none. The server asks for it only where the provider is known to support it (KOBE-326).
 */
export const SERVER_CALL_RESPONSE_FORMATS = {
  eval_judge: {
    type: "json_schema",
    json_schema: {
      name: "skill_eval_verdict",
      strict: true,
      schema: SKILL_EVAL_JUDGE_RESPONSE_SCHEMA,
    },
  },
  memory_learn: {
    type: "json_schema",
    json_schema: {
      name: "memory_extractor",
      strict: true,
      schema: MEMORY_EXTRACTOR_RESPONSE_SCHEMA,
    },
  },
} as const satisfies Partial<Record<ServerCallTokenPurpose, unknown>>;

/**
 * What a server call to a reasoning model asks for (KOBE-219 review H1): `low` keeps the
 * reasoning short and the answer in `content`. `none` moved the reasoning into the content on
 * gate1's model and `minimal` still ran out of tokens; non-reasoning models get no field at all.
 */
export const SERVER_CALL_REASONING_EFFORT = "low" as const;

/** The output cap of one call: the reasoning headroom only for a catalog reasoning model. */
export function serverCallOutputCap(purpose: ServerCallTokenPurpose, reasoning: boolean): number {
  const l = SERVER_CALL_LIMITS[purpose];
  return reasoning ? l.reasoning_max_output_tokens : l.max_output_tokens;
}

/**
 * The output cap the server puts in the token and body: {@link serverCallOutputCap}, clamped to
 * the model's catalog `maxOutputTokens` (`model_catalog.max_output_tokens`) when the catalog
 * names one. Never below 1.
 */
export function serverCallOutputCapFor(
  purpose: ServerCallTokenPurpose,
  reasoning: boolean,
  catalogMaxOutputTokens: number | null | undefined,
): number {
  const cap = serverCallOutputCap(purpose, reasoning);
  if (catalogMaxOutputTokens === null || catalogMaxOutputTokens === undefined) return cap;
  return Math.max(1, Math.min(cap, Math.floor(catalogMaxOutputTokens)));
}

/** Purposes whose token names a learning pass (`pass_id`); no other purpose carries one. */
export const PASS_SERVER_CALL_PURPOSES = ["memory_learn"] as const;

/** Whether a purpose's token must name its learning pass (`pass_id`). */
export function serverCallNamesPass(purpose: ServerCallTokenPurpose): boolean {
  return (PASS_SERVER_CALL_PURPOSES as readonly string[]).includes(purpose);
}

/**
 * Longest a learning pass may append pass events after it started (the server's append guard):
 * the extractor call and its one retry, plus reading the thread and checking the candidates.
 */
export const MEMORY_PASS_MARGIN_MS = 30_000;
export const MEMORY_PASS_MAX_MS =
  SERVER_CALL_LIMITS.memory_learn.timeout_ms * (1 + MEMORY_LEARN_SCHEMA_RETRIES) +
  MEMORY_PASS_MARGIN_MS;

const MAX_OUTPUT_CAP = Math.max(
  ...SERVER_CALL_TOKEN_PURPOSES.map((p) => SERVER_CALL_LIMITS[p].reasoning_max_output_tokens),
);

export const serverCallClaimsSchema = z
  .strictObject({
    iss: z.literal("kobe-server"),
    aud: z.literal(SERVER_CALL_AUDIENCE),
    purpose: serverCallTokenPurposeSchema,
    team_id: uuidSchema,
    /**
     * Whose budget line and virtual key: the member whose run triggered the call. Also the trace's
     * `user.id` (opaque uuid; KOBE-274 sets the attribute on the gateway's span).
     */
    user_id: uuidSchema,
    /**
     * The thread: usage attribution, and the trace's `session.id` (Langfuse sessions group a
     * thread's model calls; KOBE-274 sets it on run calls and, from this claim, on server calls).
     * Absent only for a run-less purpose ({@link RUNLESS_SERVER_CALL_PURPOSES}).
     */
    thread_id: uuidSchema.optional(),
    /**
     * The completed run that triggered the call (usage attribution and tracing). Absent only for
     * a run-less purpose, where the usage row's `run_id` is NULL.
     */
    run_id: uuidSchema.optional(),
    /**
     * The learning pass the call serves (`memory_learning_passes.id`, KOBE-390); present exactly
     * for {@link PASS_SERVER_CALL_PURPOSES}. Its run is the leaf's last completed run, so the
     * gateway's lease check admits the thread's author only.
     */
    pass_id: uuidSchema.optional(),
    /** `<gateway provider>/<model>`: the thread's resolved model (a pinned agent's model wins). */
    model: gatewayModelSchema,
    max_output_tokens: z.number().int().min(1).max(MAX_OUTPUT_CAP),
    /** Seconds since the epoch. */
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    /** Unique token id (replay refusal, audit). */
    jti: z.string().min(16).max(128).regex(NO_CONTROL_CHARS),
  })
  .refine((c) => c.exp > c.iat && c.exp - c.iat <= MAX_SERVER_CALL_TOKEN_TTL_SECONDS, {
    message: "exp must be after iat and within MAX_SERVER_CALL_TOKEN_TTL_SECONDS",
    path: ["exp"],
  })
  .refine((c) => c.max_output_tokens <= serverCallOutputCap(c.purpose, true), {
    message: "max_output_tokens is above the purpose's cap",
    path: ["max_output_tokens"],
  })
  // A run-bound purpose names its thread and run, both; a run-less one names neither (KOBE-564);
  // an optional-run purpose names both or neither (KOBE-409).
  .refine(
    (c) =>
      serverCallRunOptional(c.purpose)
        ? (c.thread_id === undefined) === (c.run_id === undefined)
        : serverCallBoundToRun(c.purpose)
          ? c.thread_id !== undefined && c.run_id !== undefined
          : c.thread_id === undefined && c.run_id === undefined,
    {
      message: "thread_id and run_id are both present for a run-bound purpose and absent otherwise",
      path: ["run_id"],
    },
  )
  .refine((c) => serverCallNamesPass(c.purpose) === (c.pass_id !== undefined), {
    message: "pass_id is present for a learning pass's purpose and absent otherwise",
    path: ["pass_id"],
  });
export type ServerCallClaims = z.infer<typeof serverCallClaimsSchema>;

export type ServerCallTokenFailure = "malformed" | "bad_signature" | "expired" | "not_yet_valid";

export type VerifyServerCallTokenResult =
  | { readonly ok: true; readonly claims: ServerCallClaims }
  | { readonly ok: false; readonly reason: ServerCallTokenFailure };

const outputLimit = z.number().int().min(1).max(MAX_OUTPUT_CAP);

/**
 * The request body a server call may send: an OpenAI Chat Completions subset. Strict, so tools,
 * functions, tool messages, images, audio, web search, logprobs, `n > 1` and streaming are all
 * refused by shape. Exactly one of `max_tokens` / `max_completion_tokens`. A message may be as
 * long as the largest purpose allows; the gateway checks the token's purpose's own cap and that
 * `response_format`, when sent, is exactly that purpose's ({@link SERVER_CALL_RESPONSE_FORMATS}).
 */
export const serverCallRequestSchema = z
  .strictObject({
    model: gatewayModelSchema,
    messages: z
      .array(
        z.strictObject({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string().min(1).max(MAX_MESSAGE_CHARS),
        }),
      )
      .min(1)
      .max(SERVER_CALL_MAX_MESSAGES),
    max_tokens: outputLimit.optional(),
    max_completion_tokens: outputLimit.optional(),
    temperature: z.number().min(0).max(2).optional(),
    stream: z.literal(false).optional(),
    n: z.literal(1).optional(),
    /** For reasoning models, so a small output cap is not spent on thinking. */
    reasoning_effort: z.enum(["none", "minimal", "low"]).optional(),
    /** Structured output (the eval judge and the extractor; compared with the purpose's format). */
    response_format: z
      .strictObject({
        type: z.literal("json_schema"),
        json_schema: z.strictObject({
          name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
          strict: z.literal(true),
          schema: z.record(z.string(), z.unknown()),
        }),
      })
      .optional(),
  })
  .refine((b) => (b.max_tokens === undefined) !== (b.max_completion_tokens === undefined), {
    message: "exactly one of max_tokens and max_completion_tokens",
  });
export type ServerCallRequest = z.infer<typeof serverCallRequestSchema>;

/** Longest generated title (well under {@link THREAD_TITLE_MAX}; the rail shows one line). */
export const GENERATED_TITLE_MAX_CHARS = 80;
/**
 * Control, format (bidi overrides, zero-width marks) and line/paragraph separator characters:
 * never in a generated title, which quotes model output (KOBE-219 review L1).
 */
export const TITLE_UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A title the server writes after normalising the model's reply (one line, no quotes). */
export const generatedTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(Math.min(GENERATED_TITLE_MAX_CHARS, THREAD_TITLE_MAX))
  .regex(NO_CONTROL_CHARS)
  .refine((t) => !TITLE_UNSAFE_CHARS.test(t), { message: "no format or separator characters" });

export const THREAD_SUGGESTIONS_MAX = 3;
export const THREAD_SUGGESTION_MAX_CHARS = 120;
/** Follow-ups as the server keeps them: one line each, at most three. */
export const threadSuggestionsSchema = z
  .array(z.string().trim().min(1).max(THREAD_SUGGESTION_MAX_CHARS).regex(NO_CONTROL_CHARS))
  .min(1)
  .max(THREAD_SUGGESTIONS_MAX);

/**
 * Epilogue (events.ts): `run.completed.epilogue` lists the server calls the server will attempt
 * for that run; their results are appended to the same run's events after `run.completed`
 * (`thread.updated`, `thread.suggestions`). The server starts the announced calls **concurrently**
 * right after `run.completed` commits, each under its own `timeout_ms`, so the window is the
 * longest call plus {@link SERVER_CALL_EPILOGUE_MARGIN_MS} (token minting, model resolution, the
 * writes). The event stream stays open until each announced result arrived or the window closed,
 * and the append guard refuses epilogue events after it (sse.ts, the server's append.ts). A call
 * that fails or is skipped writes nothing. A title is saved on the thread first and its event
 * appended after: a refused event (window closed) leaves the title saved, and the next thread read
 * shows it.
 */
export const SERVER_CALL_EPILOGUE_MARGIN_MS = 10_000;
export const SERVER_CALL_EPILOGUE_MAX_MS =
  Math.max(...SERVER_CALL_PURPOSES.map((p) => SERVER_CALL_LIMITS[p].timeout_ms)) +
  SERVER_CALL_EPILOGUE_MARGIN_MS;
