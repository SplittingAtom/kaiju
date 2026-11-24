import { randomUUID } from "node:crypto";
import { AUDIT_EVENTS, AUDIT_VIA_AGENT_KEY } from "@kaiju/db";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_FIELDS } from "../testing/site-wall-probe.js";
import {
  SITE_HIDDEN_BY_ACTION,
  SITE_HIDDEN_TARGET_KEYS,
  SITE_VIEW_TARGET_KEYS,
  siteViewEvent,
} from "./site-view.js";

/** KOBE-666 (Gate C decision 3): the Site audit view of Workspace events is an allow-list. */
const team = randomUUID();

/** Every metadata key a Workspace (team or any-scope) event may record. */
const workspaceKeys = new Set(
  Object.values(AUDIT_EVENTS)
    .filter((e) => e.scope !== "site")
    .flatMap((e) => Object.keys(e.target.shape)),
);

describe("Site audit view (KOBE-666)", () => {
  it("classifies every Workspace event key exactly once (a new key must be decided)", () => {
    const unclassified = [...workspaceKeys].filter(
      (k) => !SITE_VIEW_TARGET_KEYS.has(k) && !SITE_HIDDEN_TARGET_KEYS.has(k),
    );
    expect(unclassified).toEqual([]);
    const both = [...SITE_VIEW_TARGET_KEYS].filter((k) => SITE_HIDDEN_TARGET_KEYS.has(k));
    expect(both).toEqual([]);
    // No stale entries: every allowed key is one some Workspace event declares.
    expect([...SITE_VIEW_TARGET_KEYS].filter((k) => !workspaceKeys.has(k))).toEqual([]);
    for (const action of Object.keys(SITE_HIDDEN_BY_ACTION))
      expect(Object.keys(AUDIT_EVENTS)).toContain(action);
  });

  it("never allows a wall probe field or the via-agent record", () => {
    for (const f of [...FORBIDDEN_FIELDS, AUDIT_VIA_AGENT_KEY])
      expect(SITE_VIEW_TARGET_KEYS.has(f), f).toBe(false);
  });

  it("drops thread-derived and unknown keys from Workspace events, keeps the rest", () => {
    const e = {
      id: "e1",
      action: "memory.suggestion.created",
      teamId: team,
      target: {
        suggestionId: randomUUID(),
        candidateId: randomUUID(),
        passId: randomUUID(),
        threadId: randomUUID(),
        projectId: "p1",
        edited: true,
        somethingNew: "x",
        viaAgent: { threadId: "t", runId: "r", toolCallId: "c" },
      },
    };
    expect(siteViewEvent(e)).toEqual({ ...e, target: { projectId: "p1", edited: true } });
    // The stored event is not changed.
    expect(e.target.threadId).toBeDefined();
  });

  it("hides a folder name, but not a team's name", () => {
    expect(
      siteViewEvent({ action: "thread_folder.created", teamId: team, target: { name: "Mine" } })
        .target,
    ).toEqual({});
    expect(
      siteViewEvent({ action: "identity.team.renamed", teamId: team, target: { name: "Ops" } })
        .target,
    ).toEqual({ name: "Ops" });
  });

  it("shows Site-level events as stored", () => {
    const e = {
      action: "memory.items.exported",
      teamId: null,
      target: { scope: "site", viaAgent: { threadId: "t" } },
    };
    expect(siteViewEvent(e)).toBe(e);
  });
});
