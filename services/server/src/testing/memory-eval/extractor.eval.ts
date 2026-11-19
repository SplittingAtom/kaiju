import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CURRENT_EXTRACTOR_PROMPT, extractorMessages } from "../../memory/learn/prompt/index.js";
import { loadCases, type EvalCase } from "./extractor/cases.js";
import { extractWithModel, type ModelTarget } from "./extractor/model.js";
import { oracleReply } from "./extractor/oracle.js";
import {
  markdownReport,
  recordedRunSchema,
  resultBaseName,
  resultsRow,
  upsertResultsRow,
  type ExtractorRun,
  type RunSource,
} from "./extractor/report.js";
import { fmt, scoreCase, summarise, type Attempt, type CaseResult } from "./extractor/score.js";

/**
 * `e2e/memory-eval.sh extractor` (KOBE-400, spec U52, Gate B): runs the current extractor prompt
 * over every seeded transcript in e2e/fixtures/memory-extractor/cases/, screens and selects the
 * replies as a learning pass does, scores them and fails (non-zero exit) when a Gate B threshold
 * is missed. Three sources, from the environment (e2e/memory-eval.sh lists the variables):
 *
 * - a model (`KOBE_EXTRACTOR_URL` + `KOBE_EVAL_MODEL`): an OpenAI-compatible endpoint;
 * - a replay (`KOBE_EXTRACTOR_REPLAY=<results.json>`): an earlier run's recorded replies,
 *   re-scored (after a screen or fixture change) without the model;
 * - a dry run (`KOBE_EXTRACTOR_DRY_RUN=1`): oracle replies (fixtures/harness check, no model).
 *
 * Results: `<out>/extractor-<prompt version>-<label>.{json,md}` and a row in
 * docs/gates/gate-7b.md's results table.
 */

const flag = z.enum(["0", "1"]).optional();
const env = z
  .object({
    KOBE_EXTRACTOR_URL: z.url().optional(),
    KOBE_EXTRACTOR_API_KEY: z.string().optional(),
    KOBE_EXTRACTOR_API_KEY_FILE: z.string().optional(),
    KOBE_EVAL_MODEL: z.string().min(1).optional(),
    KOBE_EXTRACTOR_LABEL: z
      .string()
      .regex(/^[A-Za-z0-9._:/-]{1,80}$/)
      .optional(),
    KOBE_EXTRACTOR_REASONING: flag,
    KOBE_EXTRACTOR_STRUCTURED: flag,
    KOBE_EXTRACTOR_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
    KOBE_EXTRACTOR_TIMEOUT_S: z.coerce.number().int().positive().optional(),
    KOBE_EXTRACTOR_CONCURRENCY: z.coerce.number().int().min(1).max(16).optional(),
    KOBE_EXTRACTOR_ONLY: z.string().optional(),
    KOBE_EXTRACTOR_REPLAY: z.string().optional(),
    KOBE_EXTRACTOR_DRY_RUN: flag,
    KOBE_EVAL_OUT_DIR: z.string().optional(),
    /** The gate page whose results table gets the run's row; `none` skips it. */
    KOBE_EXTRACTOR_GATE_DOC: z.string().optional(),
  })
  .parse(process.env);

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CASES_DIR = join(ROOT, "e2e/fixtures/memory-extractor/cases");
const OUT_DIR = env.KOBE_EVAL_OUT_DIR ?? join(ROOT, "docs/gates/gate-7b");
const GATE_DOC = env.KOBE_EXTRACTOR_GATE_DOC ?? join(ROOT, "docs/gates/gate-7b.md");
const say = (text: string) => writeSync(1, `${text}\n`);

function messagesFor(c: EvalCase) {
  for (let i = 0; i < 3; i += 1) {
    const nonce = randomBytes(16).toString("hex");
    const built = extractorMessages(c.input, nonce);
    if (built.ok) return { ...built, nonce };
    if (built.reason !== "nonce_in_content") return built;
  }
  throw new Error(`${c.id}: no usable nonce`);
}

function modelTarget(): ModelTarget {
  const apiKey = env.KOBE_EXTRACTOR_API_KEY_FILE
    ? readFileSync(env.KOBE_EXTRACTOR_API_KEY_FILE, "utf8").trim()
    : env.KOBE_EXTRACTOR_API_KEY;
  if (!env.KOBE_EXTRACTOR_URL || !env.KOBE_EVAL_MODEL)
    throw new Error("set KOBE_EXTRACTOR_URL and KOBE_EVAL_MODEL");
  return {
    baseUrl: env.KOBE_EXTRACTOR_URL,
    model: env.KOBE_EVAL_MODEL,
    reasoning: env.KOBE_EXTRACTOR_REASONING === "1",
    structured: env.KOBE_EXTRACTOR_STRUCTURED === "1",
    ...(apiKey ? { apiKey } : {}),
    ...(env.KOBE_EXTRACTOR_MAX_OUTPUT_TOKENS
      ? { catalogMaxOutputTokens: env.KOBE_EXTRACTOR_MAX_OUTPUT_TOKENS }
      : {}),
    ...(env.KOBE_EXTRACTOR_TIMEOUT_S ? { timeoutMs: env.KOBE_EXTRACTOR_TIMEOUT_S * 1000 } : {}),
  };
}

/** Runs `work` over `items` with at most `limit` in flight, keeping the order of results. */
async function pool<T, R>(items: readonly T[], limit: number, work: (t: T) => Promise<R>) {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

interface Source {
  readonly source: RunSource;
  readonly model: string;
  readonly label: string;
  readonly recordedPromptVersion?: string;
  readonly settings: Record<string, unknown>;
  attempts(c: EvalCase): Promise<Attempt[]>;
}

function chooseSource(): Source {
  if (env.KOBE_EXTRACTOR_REPLAY) {
    const rec = recordedRunSchema.parse(
      JSON.parse(readFileSync(env.KOBE_EXTRACTOR_REPLAY, "utf8")),
    );
    const byId = new Map(rec.cases.map((c) => [c.id, c.attempts as Attempt[]]));
    return {
      source: "replay",
      model: rec.model,
      label: env.KOBE_EXTRACTOR_LABEL ?? rec.label,
      recordedPromptVersion: rec.prompt_version,
      settings: { replayed: rec.source },
      attempts: (c) =>
        Promise.resolve(byId.get(c.id) ?? [{ error: "not_recorded", latency_ms: 0 }]),
    };
  }
  if (env.KOBE_EXTRACTOR_DRY_RUN === "1")
    return {
      source: "dry-run",
      model: "dry-run",
      label: env.KOBE_EXTRACTOR_LABEL ?? "dry-run",
      settings: { fooled: true },
      attempts: (c) => Promise.resolve([{ text: oracleReply(c, true), latency_ms: 0 }]),
    };
  const target = modelTarget();
  return {
    source: "model",
    model: target.model,
    label: env.KOBE_EXTRACTOR_LABEL ?? target.model,
    settings: {
      reasoning: target.reasoning,
      structured: target.structured,
      catalog_max_output_tokens: target.catalogMaxOutputTokens ?? null,
      concurrency: env.KOBE_EXTRACTOR_CONCURRENCY ?? 4,
    },
    attempts: async (c) => {
      const built = messagesFor(c);
      if (!built.ok) return [{ error: `input_${built.reason}`, latency_ms: 0 }];
      const attempts = await extractWithModel(target, built.messages);
      return attempts.map((a) => ({ ...a, nonce: built.nonce }));
    },
  };
}

function writeResults(run: ExtractorRun, subset: boolean): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const base = join(OUT_DIR, resultBaseName(run.prompt_version, run.label));
  writeFileSync(`${base}.json`, `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(`${base}.md`, markdownReport(run));
  if (!subset && GATE_DOC !== "none" && existsSync(GATE_DOC)) {
    const link = relative(join(GATE_DOC, ".."), base);
    writeFileSync(
      GATE_DOC,
      upsertResultsRow(readFileSync(GATE_DOC, "utf8"), resultsRow(run, link)),
    );
  }
  return base;
}

describe("memory extractor eval (KOBE-400, Gate B)", () => {
  it("meets the Gate B thresholds", async () => {
    const only = env.KOBE_EXTRACTOR_ONLY ? new RegExp(env.KOBE_EXTRACTOR_ONLY) : undefined;
    const cases = loadCases(CASES_DIR).filter((c) => !only || only.test(`${c.category}/${c.id}`));
    expect(cases.length).toBeGreaterThan(0);
    const src = chooseSource();
    const started = new Date().toISOString();
    say(
      `extractor eval: ${cases.length} cases, ${CURRENT_EXTRACTOR_PROMPT.version}, ${src.source} ${src.label}`,
    );
    let done = 0;
    const results: CaseResult[] = await pool(
      cases,
      env.KOBE_EXTRACTOR_CONCURRENCY ?? 4,
      async (c) => {
        const r = scoreCase(c, await src.attempts(c));
        done += 1;
        if (src.source === "model") say(`  [${done}/${cases.length}] ${c.id}: ${r.outcome}`);
        return r;
      },
    );
    const summary = summarise(results);
    const run: ExtractorRun = {
      kind: "memory-extractor-eval",
      prompt_version: CURRENT_EXTRACTOR_PROMPT.version,
      model: src.model,
      label: src.label,
      source: src.source,
      ...(src.recordedPromptVersion ? { recorded_prompt_version: src.recordedPromptVersion } : {}),
      started_at: started,
      finished_at: new Date().toISOString(),
      settings: src.settings,
      summary,
      cases: results,
    };
    const base = writeResults(run, only !== undefined);
    const o = summary.overall;
    say(
      [
        `precision ${fmt(o.precision)}  recall ${fmt(o.recall)}  scope ${fmt(o.scope_accuracy)}  kind ${fmt(o.kind_accuracy)}`,
        `adversarial: ${summary.adversarial.shared_offers} Workspace/Site offers, pass ${summary.adversarial.passed}/${summary.adversarial.cases}; schema-valid first try ${fmt(summary.schema.valid_first_rate)}`,
        `latency p50 ${summary.latency_ms.p50} ms p95 ${summary.latency_ms.p95} ms; tokens ${summary.tokens.prompt}/${summary.tokens.completion}`,
        `results: ${base}.{json,md}${only ? " (subset: gate page not updated)" : ""}`,
        `verdict: ${summary.passed ? "PASS" : `FAIL (${summary.failures.join("; ")})`}`,
      ].join("\n"),
    );
    expect(summary.failures).toEqual([]);
  });
});
