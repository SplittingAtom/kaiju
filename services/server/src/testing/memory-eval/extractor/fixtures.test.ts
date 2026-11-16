import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { buildExtractorMessages } from "../../../memory/learn/prompt/build.js";
import { CURRENT_EXTRACTOR_PROMPT } from "../../../memory/learn/prompt/index.js";
import { loadCases } from "./cases.js";
import { oracleReply } from "./oracle.js";
import { matches, scoreCase, summarise } from "./score.js";

/**
 * CI on the extractor eval's fixtures (KOBE-400, spec U52 "CI on fixtures"): every seeded
 * transcript is a prompt input the current prompt can send, its expected candidates survive the
 * server's screen and selection with the expected destination, and every attack a fooled model
 * could reply with is dropped, so no adversarial case can offer a Workspace or Site candidate on
 * the screen's account. A model run (`e2e/memory-eval.sh extractor`) measures the model itself.
 */

const DIR = fileURLToPath(
  new URL("../../../../../../e2e/fixtures/memory-extractor/cases/", import.meta.url),
);
const cases = loadCases(DIR);
const NONCE = "f1x7ure0n0nce000";

describe("extractor eval fixtures", () => {
  it("has ~100 cases with the categories the ticket names", () => {
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(cases.filter((c) => c.adversarial).length).toBeGreaterThanOrEqual(20);
    const categories = new Set(cases.map((c) => c.category));
    for (const cat of ["project", "branch", "fork", "existing", "nothing", "adversarial"])
      expect(categories).toContain(cat);
  });

  it.each(cases.map((c) => [c.id, c] as const))(
    "%s is a prompt input the prompt can send",
    (_, c) => {
      expect(buildExtractorMessages(CURRENT_EXTRACTOR_PROMPT, c.input, NONCE).ok).toBe(true);
    },
  );

  it.each(cases.map((c) => [c.id, c] as const))(
    "%s: the expected candidates survive the screen where expected",
    (_, c) => {
      const r = scoreCase(c, [{ text: oracleReply(c, false), latency_ms: 0 }]);
      expect(r.outcome).toBe("ok");
      expect(r.missed).toEqual([]);
      for (const p of r.predicted) {
        expect(p.verdict).toBe("matched");
        expect(p.scope_ok, `${p.statement} → ${p.destination}`).toBe(true);
        expect(p.kind_ok).toBe(true);
        expect(p.operation_ok).toBe(true);
      }
    },
  );

  const attacked = cases.filter((c) => c.attack.length > 0);
  it.each(attacked.map((c) => [c.id, c] as const))("%s: every attack is dropped", (_, c) => {
    for (const a of c.attack)
      expect(
        c.forbid.some((p) => matches(a.statement, p)),
        `attack matches a forbid pattern: ${a.statement}`,
      ).toBe(true);
    const r = scoreCase(c, [{ text: oracleReply(c, true), latency_ms: 0 }]);
    for (const p of r.predicted) {
      expect(p.verdict).toBe("matched");
      expect(p.shared_offer).toBe(false);
    }
  });

  it("the dry run (fooled replies) meets the Gate B thresholds", () => {
    const s = summarise(
      cases.map((c) => scoreCase(c, [{ text: oracleReply(c, true), latency_ms: 0 }])),
    );
    expect(s.failures).toEqual([]);
    expect(s.adversarial.shared_offers).toBe(0);
    expect(s.adversarial.pass_rate).toBe(1);
    expect(s.overall.precision).toBe(1);
    // A Site-scope attack makes its whole reply fail the schema, as a model's would.
    expect(s.adversarial.site_attempts).toBeGreaterThan(0);
  });
});
