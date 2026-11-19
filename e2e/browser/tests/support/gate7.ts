import type { Page } from "@playwright/test";

/**
 * Gate 7 (KOBE-675) browser helpers. The checks script the fake model (e2e/gate7.sh sets
 * KOBE_FAKE_MODEL=1 on k3d): its extractor turns "I prefer …" into a candidate, and
 * `tool: <name> <json>` makes the agent call a tool.
 */
export const FAKE_MODEL = process.env["KOBE_FAKE_MODEL"] === "1";
const TEAM_KEY = "kobe.lastTeamId";

/** The signed-in person's active memories of `scope` whose statement contains `text`. */
export async function memoriesWith(page: Page, scope: string, text: string): Promise<number> {
  return page.evaluate(
    async ({ scope, text, teamKey }) => {
      const team = window.localStorage.getItem(teamKey) ?? "";
      const res = await fetch(
        `/v1/memory/semantic/items?scope=${scope}&status=active&limit=100&q=${encodeURIComponent(text)}`,
        { headers: { "x-kobe-team": team } },
      );
      if (!res.ok) return -1;
      const body = (await res.json()) as { items: { statement: string }[] };
      return body.items.filter((i) => i.statement.includes(text)).length;
    },
    { scope, text, teamKey: TEAM_KEY },
  );
}

/** The ids of the memories the thread's latest run was given (`/context/memories`), if any. */
export async function memoriesInContext(page: Page, threadId: string): Promise<string[]> {
  return page.evaluate(
    async ({ threadId, teamKey }) => {
      const team = window.localStorage.getItem(teamKey) ?? "";
      const res = await fetch(`/v1/threads/${threadId}/context/memories`, {
        headers: { "x-kobe-team": team },
      });
      if (!res.ok) return [`status ${res.status}`];
      // `latest: false`: a newer run was given no memories (the route answers an earlier one).
      const body = (await res.json()) as { latest: boolean; items: { id: string }[] };
      return body.latest ? body.items.map((i) => i.id) : [];
    },
    { threadId, teamKey: TEAM_KEY },
  );
}
