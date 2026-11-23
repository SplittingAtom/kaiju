// Shared setup for the agent-builder-pages.*.test.tsx files
// (split from agent-builder-pages.test.tsx, KOBE-725).
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { forbidNativeConfirm } from "./testing";

export const AGENT = {
  id: "a-1",
  scope: "team",
  slug: "triage",
  name: "Triage",
  status: "active",
  ownerUserId: "u-me",
  currentVersion: 2,
  revision: 3,
  updatedAt: "2026-10-01T10:00:00Z",
  canEdit: true,
  canPublish: true,
  canExport: true,
  starters: [],
  frontmatter: { name: "Triage", approval_mode: "ask-on-write" },
  prompt: "Be helpful.",
};
export const VERSIONS = {
  current_version: 2,
  versions: [
    {
      version: 2,
      published_by: "u-me",
      published_at: "2026-10-02T10:00:00Z",
      draft_revision: 2,
      republished_from: null,
    },
    {
      version: 1,
      published_by: "u-me",
      published_at: "2026-10-01T10:00:00Z",
      draft_revision: 1,
      republished_from: null,
    },
  ],
  next_before: null,
};
export const MODELS = {
  models: ["fast", "smart", "local"].map((alias) => ({
    alias,
    label: alias === "smart" ? "Smart" : null,
    enabled: alias !== "local",
    is_default: alias === "fast",
  })),
  default: "fast",
};
export const READ = {
  "GET /v1/team/models": [200, MODELS],
  "GET /v1/agents/a-1": [200, { agent: AGENT }],
  "GET /v1/agents/a-1/versions": [200, VERSIONS],
  // The Memory section reads the current version's setting (KOBE-646).
  "GET /v1/agents/a-1/versions/2": [
    200,
    { version: { ...VERSIONS.versions[0], frontmatter: AGENT.frontmatter, prompt: AGENT.prompt } },
  ],
} as const;

export let assign: ReturnType<typeof vi.fn>;

/**
 * Registers the shared hooks; call once at the top level of each
 * agent-builder-pages.*.test.tsx file.
 */
export function useAgentBuilderStubs(): void {
  beforeEach(() => {
    forbidNativeConfirm();
    assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, reload: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}
