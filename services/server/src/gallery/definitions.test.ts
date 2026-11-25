import { describe, expect, it } from "vitest";
import { agentConnectors, agentSkills } from "@kaiju/agent-file";
import { BUILTIN_TOOLS, KAIJU_SKILL_NAMES } from "@kaiju/protocol";
import { computeToolManifest, manifestAllowsTool } from "../agents/manifest.js";
import { GALLERY_DEFINITIONS, KAIJU_GALLERY_KEY, parseGalleryDefinitions } from "./definitions.js";

describe("the repo's gallery definitions", () => {
  it("all parse, with unique keys and positive generations", () => {
    expect(() => parseGalleryDefinitions(GALLERY_DEFINITIONS)).not.toThrow();
  });

  it("refuses a missing generation", () => {
    const file = "---\nname: X\n---\nx\n";
    expect(() => parseGalleryDefinitions([{ key: "x", generation: 0, file }])).toThrow(
      /generation/,
    );
  });
});

describe("the one gallery agent, Kaiju (KOBE-254)", () => {
  const parsed = parseGalleryDefinitions(GALLERY_DEFINITIONS);
  const kaiju = parsed[0]?.definition;
  if (!kaiju) throw new Error("no gallery definition");
  const floor = { scope: "site", site: [], team: [], approvalFloor: "auto" } as const;
  const manifest = computeToolManifest(kaiju.frontmatter, floor, new Date());

  it("ships exactly one gallery agent, Kaiju, at generation 6", () => {
    // 2: the web-search notice is scoped to requests that need the web (review of #240).
    // 3: no built-in web search any more; research goes through connectors (KOBE-606).
    // 5: renamed Kaiju (KOBE-831); installs that customized it keep their own name.
    // 6: names the guide skill kaiju-guide (KOBE-833).
    expect(parsed.map((p) => [p.key, p.generation])).toEqual([[KAIJU_GALLERY_KEY, 6]]);
    expect(kaiju.frontmatter.skills).toContain("kaiju-guide");
    expect(KAIJU_GALLERY_KEY).toBe("kaiju");
    expect(kaiju.frontmatter.name).toBe("Kaiju");
    expect(kaiju.frontmatter.description).toBeTruthy();
    expect(kaiju.frontmatter.starters?.length).toBeGreaterThan(0);
  });

  it("pins no model, narrows no tool and asks for every team connector", () => {
    expect(kaiju.frontmatter.model).toBeUndefined();
    expect(kaiju.frontmatter.tools).toBeUndefined();
    expect(kaiju.frontmatter.approval_mode).toBeUndefined();
    expect(agentConnectors(kaiju.frontmatter)).toEqual({ all: true, names: [] });
  });

  it("freezes every available built-in tool and `all` connectors (ac-1)", () => {
    const unavailable = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
    const available = Object.keys(BUILTIN_TOOLS)
      .filter((n) => !unavailable.includes(n))
      .sort();
    expect(manifest.tools.map((t) => t.name)).toEqual(available);
    expect(manifest.excluded.every((e) => e.reason === "unavailable")).toBe(true);
    expect(manifest.connectors).toBe("all");
    for (const tool of ["create_artifact", "update_artifact", "share_file"]) {
      expect(manifestAllowsTool(manifest, tool), tool).toBe(true);
    }
  });

  it("lists every Kaiju skill (the former built-ins), and only those", () => {
    expect([...agentSkills(kaiju.frontmatter).names].sort()).toEqual([...KAIJU_SKILL_NAMES].sort());
  });

  it("keeps the prompt general-purpose and concise", () => {
    expect(kaiju.prompt.length).toBeGreaterThan(500);
    expect(new TextEncoder().encode(kaiju.prompt).length).toBeLessThan(5000);
  });

  it("researches through connectors, with URLs, and never names the retired web_search (KOBE-606)", () => {
    expect(kaiju.prompt).not.toMatch(/web_search|web search/i);
    const research = kaiju.prompt.slice(kaiju.prompt.indexOf("Research:"));
    expect(research).toMatch(/^Research: for current or outside facts, use a connector tool/);
    expect(research).toMatch(/URL/);
    // Says so only when a request needs outside facts: never as the opening of every reply.
    expect(research).toMatch(/no connector can provide them, say so plainly/);
    expect(research).toMatch(/do not mention it for requests that do not need outside facts/);
  });

  it("carries the Document Drafter's Markdown preview artifact (KOBE-131) and share_file (KOBE-152)", () => {
    expect(kaiju.prompt).toMatch(/docx/);
    expect(kaiju.prompt).toMatch(/create_artifact with kind markdown/);
    expect(kaiju.prompt).toMatch(/update_artifact/);
    expect(kaiju.prompt).toMatch(/share_file/);
  });

  it("carries the data, code and artifact guidance of the agents it replaced", () => {
    expect(kaiju.prompt).toMatch(/data-analysis skill/);
    expect(kaiju.prompt).toMatch(/html artifact/);
    expect(kaiju.prompt).toMatch(/xlsx/);
    expect(kaiju.prompt).toMatch(/code-review skill/);
    expect(kaiju.prompt).toMatch(/skill-creator skill/);
    for (const what of ["HTML", "diagram", "table", "code"]) expect(kaiju.prompt).toContain(what);
  });
});
