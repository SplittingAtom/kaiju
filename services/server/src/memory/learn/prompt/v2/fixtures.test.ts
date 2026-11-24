import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMemoryExtractorOutput } from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import { screenExtractorOutput } from "../../screen.js";
import { buildExtractorMessages } from "../build.js";
import { extractorPromptInputSchema } from "../input.js";
import { INSTRUCTIONS, PROMPT_VERSION, SYSTEM } from "./prompt.js";

/**
 * Recorded extractor replies for prompt v2 (KOBE-660; the fixtures are v1's, KOBE-394), replayed with no model: each fixture holds
 * a pass input, the reply a model gave (or would give when fooled), and what must survive the
 * parser and `screenExtractorOutput`. Adversarial fixtures must leave no Workspace candidate.
 */

const DIR = join(import.meta.dirname, "fixtures");
const NONCE = "f1x7ure0n0nce000";

interface Fixture {
  readonly description: string;
  readonly adversarial: boolean;
  readonly input: unknown;
  readonly reply: unknown;
  readonly expect:
    | { readonly schema: "rejected" }
    | {
        readonly schema: "ok";
        readonly kept: readonly { statement: string; destination: string }[];
        readonly dropped: readonly string[];
        readonly skill_hints: number;
      };
}

const names = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length))
  .sort();
const load = (name: string): Fixture =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Fixture;
const replyText = (reply: unknown): string =>
  typeof reply === "string" ? reply : JSON.stringify(reply);

describe(`extractor fixtures, ${PROMPT_VERSION}`, () => {
  it("pins the prompt bytes: editing them needs a new version and new recordings", () => {
    const digest = createHash("sha256").update(`${SYSTEM}\n\0\n${INSTRUCTIONS}`).digest("hex");
    expect(readFileSync(join(DIR, "prompt.sha256"), "utf8").trim()).toBe(digest);
  });

  it("covers the normal and adversarial cases the spec names", () => {
    expect(names).toEqual(
      expect.arrayContaining([
        "adversarial-agent-hallucination",
        "adversarial-branch-summary",
        "adversarial-injected-tool-output",
        "adversarial-secret-in-chat",
        "adversarial-third-party-personal",
        "normal-project-fact",
        "normal-preferences",
      ]),
    );
  });

  describe.each(names)("%s", (name) => {
    const fx = load(name);
    const input = extractorPromptInputSchema.parse(fx.input);

    it("is a prompt input v2 can send", () => {
      const built = buildExtractorMessages(
        { version: PROMPT_VERSION, system: SYSTEM, instructions: INSTRUCTIONS },
        input,
        NONCE,
      );
      expect(built.ok).toBe(true);
    });

    it("replays to the recorded outcome", () => {
      const parsed = parseMemoryExtractorOutput(replyText(fx.reply));
      if (fx.expect.schema === "rejected") {
        expect(parsed).toEqual({ ok: false, reason: "schema_rejected" });
        return;
      }
      if (!parsed.ok) throw new Error(`${name}: reply fails the schema`);
      const screened = screenExtractorOutput(parsed.output, input);
      expect(
        screened.kept.map((k) => ({
          statement: k.candidate.statement,
          destination: k.destination,
        })),
      ).toEqual(fx.expect.kept);
      expect(screened.dropped.map((d) => d.reason)).toEqual(fx.expect.dropped);
      expect(screened.skill_hints).toHaveLength(fx.expect.skill_hints);
      for (const k of screened.kept.filter((x) => x.destination === "project_notes"))
        expect(k.candidate.project_specific).toBe(true);
    });

    if (fx.adversarial)
      it("leaves no Workspace or Site candidate", () => {
        const parsed = parseMemoryExtractorOutput(replyText(fx.reply));
        const kept = parsed.ok ? screenExtractorOutput(parsed.output, input).kept : [];
        for (const k of kept) expect(["user", "portable"]).toContain(k.destination);
      });
  });
});
