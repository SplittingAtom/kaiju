import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { AgentDefinition } from "@kaiju/agent-file";
import { computeToolManifest, type PublishFloor, type ToolManifest } from "../manifest.js";
import { mapAgentVersionToOrbit, orbitExportToYaml } from "./orbit-export.js";
import {
  BOTH_METADATA_SECTIONS_MESSAGE,
  orbitExperimentSchema,
  orbitKaijuSection,
} from "./orbit-schema.js";

const NOW = new Date("2026-10-02T12:00:00Z");
const FLOOR: PublishFloor = { scope: "team", site: [], team: [], approvalFloor: "auto" };

const definition = (
  frontmatter: Partial<AgentDefinition["frontmatter"]> = {},
  prompt = "You are a careful analyst.",
): AgentDefinition => ({ frontmatter: { name: "Sales Analyst", ...frontmatter }, prompt });

const manifestFor = (def: AgentDefinition): ToolManifest =>
  computeToolManifest(def.frontmatter, FLOOR, NOW);

const exportOf = (
  def: AgentDefinition,
  extra: { mcpTools?: readonly string[]; version?: number } = {},
) =>
  mapAgentVersionToOrbit({ definition: def, toolManifest: manifestFor(def), version: 3, ...extra });

describe("mapAgentVersionToOrbit (KOBE-90)", () => {
  it("maps role, prompt and one agent into Orbit's setup layer", () => {
    const def = definition({ role: "Analyst", description: "Crunches numbers" });
    const { config } = exportOf(def);
    expect(config.name).toBe("kaiju-sales-analyst-v3");
    expect(config.description).toBe("Crunches numbers");
    expect(config.setup.agents).toHaveLength(1);
    expect(config.setup.agents[0]).toMatchObject({
      name: "sales-analyst",
      role: "Analyst",
      system_prompt: "You are a careful analyst.",
    });
    expect(config.setup.edges).toEqual([]);
  });

  it("falls back to a neutral role", () => {
    expect(exportOf(definition()).config.setup.agents[0]?.role).toBe("assistant");
  });

  it("ac-2: tools are exactly the frozen manifest's, not the agent file's request", () => {
    const def = definition({ tools: { allow: ["read", "grep", "bash"], deny: ["bash"] } });
    const manifest = manifestFor(def);
    const { config } = mapAgentVersionToOrbit({
      definition: def,
      toolManifest: manifest,
      version: 1,
    });
    expect(config.setup.agents[0]?.tools).toEqual(manifest.tools.map((t) => t.name));
    expect(config.setup.agents[0]?.tools).toEqual(["grep", "read"]);
  });

  it("passes MCP tools of the version's connectors as plain tool names", () => {
    const def = definition({ connectors: ["github-prod"], tools: { allow: ["read"] } });
    const { config, warnings } = exportOf(def, {
      mcpTools: ["mcp__github_prod__list_issues", "mcp__github_prod__get_pr"],
    });
    expect(config.setup.agents[0]?.tools).toEqual([
      "read",
      "mcp__github_prod__get_pr",
      "mcp__github_prod__list_issues",
    ]);
    expect(warnings).toEqual([]);
  });

  it("refuses MCP tools of a connector the version does not list", () => {
    const def = definition({ connectors: ["github"] });
    expect(() => exportOf(def, { mcpTools: ["mcp__slack__post"] })).toThrow(/connector/);
  });

  it("passes the team's MCP tools for `connectors: all` and records `all` (KOBE-254)", () => {
    const def = definition({ connectors: "all", tools: { allow: ["read"] } });
    const { config } = exportOf(def, { mcpTools: ["mcp__slack__post", "mcp__github__get_pr"] });
    expect(config.setup.agents[0]?.tools).toEqual([
      "read",
      "mcp__github__get_pr",
      "mcp__slack__post",
    ]);
    expect(config.metadata.kaiju).toMatchObject({ connectors: "all" });
    expect(() => exportOf(def, { mcpTools: ["not_mcp"] })).toThrow(/connector/);
  });

  it("drops MCP tools Orbit cannot name and says so", () => {
    const def = definition({ connectors: ["github"] });
    const long = `mcp__github__${"x".repeat(60)}`;
    const { config, warnings } = exportOf(def, { mcpTools: [long, "mcp__github__ok.tool"] });
    expect(config.setup.agents[0]?.tools.some((t) => t.startsWith("mcp__"))).toBe(false);
    expect(warnings).toHaveLength(2);
  });

  it("keeps a provider model id and drops a Kaiju catalog alias with a warning", () => {
    const withId = exportOf(definition({ model: "ollama/qwen3:32b" }));
    expect(withId.config.setup.agents[0]?.model).toBe("ollama/qwen3:32b");
    const alias = exportOf(definition({ model: "smart" }));
    expect(alias.config.setup.agents[0]).not.toHaveProperty("model");
    expect(alias.warnings.join()).toMatch(/smart/);
  });

  it("records provenance in metadata", () => {
    const def = definition({ connectors: ["github"], approval_mode: "ask-on-write" });
    const { config } = exportOf(def);
    expect(config.metadata).toEqual({
      kaiju: {
        agent_version: 3,
        approval_mode: "ask-on-write",
        connectors: ["github"],
        manifest_format: 1,
      },
    });
  });

  it("is pure: inputs are not mutated and output is deterministic", () => {
    const def = definition({ connectors: ["github"] });
    const manifest = manifestFor(def);
    const before = JSON.stringify([def, manifest]);
    const a = mapAgentVersionToOrbit({ definition: def, toolManifest: manifest, version: 2 });
    const b = mapAgentVersionToOrbit({ definition: def, toolManifest: manifest, version: 2 });
    expect(JSON.stringify([def, manifest])).toBe(before);
    expect(orbitExportToYaml(a)).toBe(orbitExportToYaml(b));
  });

  it("output satisfies the captured Orbit schema, and YAML round-trips", () => {
    const def = definition({ role: "Analyst", model: "openai/gpt-4o", connectors: ["github"] });
    const result = exportOf(def, { mcpTools: ["mcp__github__list_issues"] });
    expect(orbitExperimentSchema.parse(result.config)).toEqual(result.config);
    expect(parse(orbitExportToYaml(result))).toEqual(result.config);
  });

  it("preserves awkward prompts (multi-line, YAML-significant, unicode)", () => {
    const prompt = "line one\n\n- not a list: really\n# not a comment\n'quoted' \"double\" ünï ✓";
    const { config } = exportOf(definition({}, prompt));
    expect(parse(orbitExportToYaml({ config, warnings: [] })).setup.agents[0].system_prompt).toBe(
      prompt,
    );
  });

  it("rejects a schema-invalid export (a tool Orbit reserves)", () => {
    const def = definition();
    const manifest = manifestFor(def);
    const bad = {
      ...manifest,
      tools: [{ ...(manifest.tools[0] as ToolManifest["tools"][number]), name: "submit" }],
    };
    expect(() =>
      mapAgentVersionToOrbit({ definition: def, toolManifest: bad, version: 1 }),
    ).toThrow(/submit/);
  });

  it("fixtures match the mapper (CI loads them with Orbit's real loader)", () => {
    const full = definition(
      {
        role: "Analyst",
        description: "Crunches numbers",
        model: "openai/gpt-4o",
        connectors: ["github"],
        tools: { allow: ["read", "grep", "bash"], deny: ["bash"] },
        approval_mode: "ask-on-write",
      },
      "Be precise.\n\nCite sources: always.",
    );
    const cases: Record<string, ReturnType<typeof exportOf>> = {
      minimal: exportOf(definition(), { version: 1 }),
      full: mapAgentVersionToOrbit({
        definition: full,
        toolManifest: manifestFor(full),
        version: 7,
        mcpTools: ["mcp__github__list_issues"],
      }),
    };
    for (const [name, result] of Object.entries(cases)) {
      const file = new URL(`./fixtures/${name}.yaml`, import.meta.url);
      // KAIJU_UPDATE_FIXTURES=1 regenerates them; review the diff, CI loads them in Orbit.
      if (process.env.KAIJU_UPDATE_FIXTURES === "1") writeFileSync(file, orbitExportToYaml(result));
      expect(readFileSync(file, "utf8"), name).toBe(orbitExportToYaml(result));
    }
  });
});

/** KOBE-832 (spec rename-kaiju §11 A11): written `kaiju:`, both names read, both refused. */
describe("Kaiju's metadata section, before and after the rename", () => {
  const provenance = { agent_version: 1, manifest_format: 1 };
  const file = (metadata: string) =>
    parse(
      `name: kaiju-a-v1\nsetup:\n  agents:\n    - name: a\n      role: r\n      system_prompt: p\n      tools: [read]\n  edges: []\nmetadata:\n${metadata}`,
    ) as unknown;

  it("the export writes `kaiju:` and never the old name", () => {
    const yaml = orbitExportToYaml(exportOf(definition()));
    expect(yaml).toMatch(/^metadata:\n {2}kaiju:\n/m);
    expect(yaml).not.toMatch(/^\s*kobe:/m);
  });

  it("reads a file exported before the rename (`kobe:`) and a current one (`kaiju:`)", () => {
    const old = orbitExperimentSchema.parse(
      file("  kobe:\n    agent_version: 1\n    manifest_format: 1\n"),
    );
    expect(orbitKaijuSection(old.metadata)).toEqual({ ok: true, key: "kobe", section: provenance });
    const current = orbitExperimentSchema.parse(
      file("  kaiju:\n    agent_version: 1\n    manifest_format: 1\n"),
    );
    expect(orbitKaijuSection(current.metadata)).toEqual({
      ok: true,
      key: "kaiju",
      section: provenance,
    });
    expect(orbitKaijuSection({ other: 1 })).toEqual({
      ok: true,
      key: undefined,
      section: undefined,
    });
  });

  it("refuses a file with both sections, saying which to keep", () => {
    const both = file("  kaiju:\n    agent_version: 1\n  kobe:\n    agent_version: 1\n");
    const checked = orbitExperimentSchema.safeParse(both);
    expect(checked.success).toBe(false);
    expect(checked.error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([
      ["metadata", BOTH_METADATA_SECTIONS_MESSAGE],
    ]);
    expect(BOTH_METADATA_SECTIONS_MESSAGE).toMatch(/Keep `kaiju:` only/);
    expect(orbitKaijuSection({ kaiju: {}, kobe: {} })).toEqual({
      ok: false,
      message: BOTH_METADATA_SECTIONS_MESSAGE,
    });
  });
});
