import { z } from "zod";
import { fmt, type CaseResult, type ExtractorSummary } from "./score.js";

/**
 * The extractor eval's results (KOBE-400): one JSON file (everything, including each case's raw
 * replies, so a run can be re-scored offline with `KOBE_EXTRACTOR_REPLAY`) and one Markdown page
 * per prompt version and model, plus a row in docs/gates/gate-7b.md's results table.
 */

export type RunSource = "model" | "replay" | "dry-run";

export interface ExtractorRun {
  readonly kind: "memory-extractor-eval";
  readonly prompt_version: string;
  /** The model id sent to the provider (`dry-run` for the oracle replies). */
  readonly model: string;
  /** The name results are filed under (the Site's learning model alias, by default the model). */
  readonly label: string;
  readonly source: RunSource;
  /** For a replay: the prompt version the replies were recorded with. */
  readonly recorded_prompt_version?: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly summary: ExtractorSummary;
  readonly cases: readonly CaseResult[];
}

/** What a replay needs from an earlier run's JSON. */
export const recordedRunSchema = z.object({
  kind: z.literal("memory-extractor-eval"),
  prompt_version: z.string(),
  model: z.string(),
  label: z.string(),
  source: z.enum(["model", "replay", "dry-run"]),
  cases: z.array(
    z.object({
      id: z.string(),
      attempts: z.array(
        z.object({
          text: z.string().optional(),
          error: z.string().optional(),
          latency_ms: z.number(),
          prompt_tokens: z.number().optional(),
          completion_tokens: z.number().optional(),
          nonce: z.string().optional(),
        }),
      ),
    }),
  ),
});
export type RecordedRun = z.infer<typeof recordedRunSchema>;

/** `memory-extractor-v1` + `glm-5.3-flash` → `extractor-memory-extractor-v1-glm-5.3-flash`. */
export const resultBaseName = (promptVersion: string, label: string): string =>
  `extractor-${promptVersion}-${label}`.replace(/[^A-Za-z0-9._-]+/g, "_");

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const mark = (ok: boolean): string => (ok ? "pass" : "**FAIL**");

function metricsTable(run: ExtractorRun): string[] {
  const s = run.summary;
  const t = s.thresholds;
  return [
    "| Metric | Value | Threshold | |",
    "| --- | --- | --- | --- |",
    `| Precision | ${fmt(s.overall.precision)} | ≥ ${t.precision} | ${mark(s.overall.precision >= t.precision)} |`,
    `| Recall | ${fmt(s.overall.recall)} | ≥ ${t.recall} | ${mark(s.overall.recall >= t.recall)} |`,
    `| Scope accuracy | ${fmt(s.overall.scope_accuracy)} | ≥ ${t.scope_accuracy} | ${mark(s.overall.scope_accuracy >= t.scope_accuracy)} |`,
    `| Adversarial Workspace/Site candidates | ${s.adversarial.shared_offers} | 0 (hard fail) | ${mark(s.adversarial.shared_offers === 0)} |`,
    `| Kind accuracy | ${fmt(s.overall.kind_accuracy)} | (reported) | |`,
    `| Operation accuracy | ${fmt(s.overall.operation_accuracy)} | (reported) | |`,
    `| Adversarial pass rate | ${pct(s.adversarial.pass_rate)} (${s.adversarial.passed}/${s.adversarial.cases}) | (reported) | |`,
    `| Site-scope attempts (schema-rejected) | ${s.adversarial.site_attempts} | (reported) | |`,
    `| Schema-valid replies, first try / after retry | ${pct(s.schema.valid_first_rate)} / ${pct(s.schema.valid_rate)} | (reported) | |`,
    `| Latency per call p50 / p95 / max | ${s.latency_ms.p50} / ${s.latency_ms.p95} / ${s.latency_ms.max} ms | (reported) | |`,
    `| Tokens prompt / completion (${s.tokens.calls} calls) | ${s.tokens.reported ? `${s.tokens.prompt} / ${s.tokens.completion}` : "not reported"} | (reported) | |`,
  ];
}

function categoryTable(run: ExtractorRun): string[] {
  return [
    "| Category | Cases | Expected | Proposed | Matched | Unexpected | Forbidden | Precision | Recall | Scope | Kind |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...Object.entries(run.summary.by_category).map(
      ([cat, m]) =>
        `| ${cat} | ${m.cases} | ${m.expected} | ${m.proposed} | ${m.matched} | ${m.unexpected} | ${m.forbidden} | ${fmt(m.precision)} | ${fmt(m.recall)} | ${fmt(m.scope_accuracy)} | ${fmt(m.kind_accuracy)} |`,
    ),
  ];
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 160);

function detailLines(run: ExtractorRun): string[] {
  const lines: string[] = [];
  for (const r of run.cases) {
    const bad = r.predicted.filter(
      (p) =>
        p.verdict === "unexpected" ||
        p.verdict === "forbidden" ||
        p.shared_offer ||
        p.scope_ok === false,
    );
    if (bad.length === 0 && r.missed.length === 0 && r.outcome === "ok") continue;
    const parts = [
      ...(r.outcome === "ok" ? [] : [`reply ${r.outcome}`]),
      ...r.missed.map((m) => `missed: ${cell(m)}`),
      ...bad.map(
        (p) =>
          `${p.shared_offer ? "SHARED OFFER " : ""}${p.verdict}${p.scope_ok === false ? " (wrong scope)" : ""} → ${p.destination}: ${cell(p.statement)}`,
      ),
    ];
    lines.push(`| ${r.id} | ${parts.join("<br>")} |`);
  }
  return lines.length === 0
    ? ["Every case matched exactly."]
    : ["| Case | What differed |", "| --- | --- |", ...lines];
}

export function markdownReport(run: ExtractorRun): string {
  const s = run.summary;
  return [
    `# Extractor eval: ${run.prompt_version} on ${run.label}`,
    "",
    `Source: ${run.source}${run.source === "dry-run" ? " (oracle replies through the real parser, screen and selection; not a model measurement)" : ""}. ` +
      `Model sent: \`${run.model}\`. ${run.recorded_prompt_version && run.recorded_prompt_version !== run.prompt_version ? `Replies recorded with ${run.recorded_prompt_version}. ` : ""}` +
      `Run ${run.started_at} to ${run.finished_at}. Settings: \`${JSON.stringify(run.settings)}\`.`,
    "",
    `**Verdict: ${s.passed ? "PASS" : "FAIL"}**${s.failures.length > 0 ? ` (${s.failures.join("; ")})` : ""}`,
    "",
    ...metricsTable(run),
    "",
    "## By category",
    "",
    ...categoryTable(run),
    "",
    `Screen and selection drops: \`${JSON.stringify(s.dropped)}\`. Adversarial cases failed: ${s.adversarial.failed_cases.length === 0 ? "none" : s.adversarial.failed_cases.join(", ")}.`,
    "",
    "## Differences",
    "",
    ...detailLines(run),
    "",
  ].join("\n");
}

export const RESULTS_START = "<!-- extractor-results:start -->";
export const RESULTS_END = "<!-- extractor-results:end -->";
const RESULTS_HEADER = [
  "| Prompt version | Model | Source | Date | Precision | Recall | Scope | Kind | Adv. offers | Adv. pass | Schema-valid | p50 / p95 ms | Verdict | Results |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

/** The run's row in the gate page's results table. `link` is relative to the page. */
export function resultsRow(run: ExtractorRun, link: string): string {
  const s = run.summary;
  return `| ${run.prompt_version} | ${run.label} | ${run.source} | ${run.finished_at.slice(0, 10)} | ${fmt(s.overall.precision)} | ${fmt(s.overall.recall)} | ${fmt(s.overall.scope_accuracy)} | ${fmt(s.overall.kind_accuracy)} | ${s.adversarial.shared_offers} | ${pct(s.adversarial.pass_rate)} | ${pct(s.schema.valid_first_rate)} | ${s.latency_ms.p50} / ${s.latency_ms.p95} | ${s.passed ? "PASS" : "FAIL"} | [md](${link}.md) · [json](${link}.json) |`;
}

/**
 * Puts `row` into the table between the markers of `page`, replacing the row for the same prompt
 * version and model. Returns the page unchanged when it has no markers.
 */
export function upsertResultsRow(page: string, row: string): string {
  const start = page.indexOf(RESULTS_START);
  const end = page.indexOf(RESULTS_END);
  if (start < 0 || end < start) return page;
  const key = (r: string) =>
    r
      .split("|")
      .slice(1, 3)
      .map((c) => c.trim())
      .join("|");
  const body = page
    .slice(start + RESULTS_START.length, end)
    .split("\n")
    // Prettier may have padded the table: skip its header and separator by shape, not bytes.
    .filter(
      (l) => l.startsWith("|") && !/^\|[\s:|-]+\|$/.test(l) && !/^\|\s*Prompt version/.test(l),
    );
  const rows = [...body.filter((r) => key(r) !== key(row)), row].sort();
  return [
    page.slice(0, start + RESULTS_START.length),
    "",
    ...RESULTS_HEADER,
    ...rows,
    "",
    page.slice(end),
  ].join("\n");
}
