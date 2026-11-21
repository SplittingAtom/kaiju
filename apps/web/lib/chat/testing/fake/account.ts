/** The caller, their teams, apps, models and agents, notifications (KOBE-717 area). */
import type { FakeCore } from "./core";
import { error, json, NOW, uuid, type FakeAnswer, type FakeRequest, type Json } from "./state";

export function notificationRoute(k: FakeCore, method: string, url: URL): Response {
  const unread = () => k.notifications.filter((n) => n.read_at === null);
  if (method === "POST") {
    const before = unread().length;
    for (const n of k.notifications) n.read_at = NOW;
    return json(200, { updated: before, unread_count: 0 });
  }
  const only = url.searchParams.get("unread") === "true";
  const list = only ? unread() : k.notifications;
  return json(200, { notifications: list, unread_count: unread().length, next_cursor: null });
}

/** Answers its paths; undefined for any other. */
export function accountArea(k: FakeCore, req: FakeRequest): FakeAnswer {
  const { method, url, headers } = req;
  const body = req.body;
  // The member and their access in the active team (the My area pages beside the thread, KOBE-424).
  if (url.pathname === "/v1/me" && method === "GET") {
    return json(200, {
      user: { id: uuid(3, 1), name: "Ann", email: "ann@example.com" },
      site_role: null,
    });
  }
  if (url.pathname === "/v1/team/apps" && method === "GET") {
    return json(200, { apps: k.teamApps, needsKey: k.teamAppsNeedKey });
  }
  if (/^\/v1\/team\/apps\/[0-9a-f]{64}\/calls$/.test(url.pathname) && method === "POST") {
    const refusal = k.appCallError;
    if (refusal) {
      return json(refusal.status, { error: { code: refusal.code, message: refusal.message } });
    }
    return json(200, { result: k.appCallResult });
  }
  if (url.pathname === "/v1/team" && method === "GET") {
    return json(200, {
      team: { id: k.teamId, slug: "fin", name: "Finance" },
      role: k.teamRole,
      permissions: ["team.chat"],
    });
  }
  if (url.pathname === "/v1/me/teams") {
    return json(200, {
      activeTeamId: k.activeTeamId,
      lastTeamId: k.lastTeamId,
      teams: [{ id: k.teamId, slug: "fin", name: "Finance", role: k.teamRole }, ...k.otherTeams],
    });
  }
  if (url.pathname === "/v1/me/teams/active" && method === "PUT") {
    k.activeTeamId = ((body as { teamId?: string } | undefined)?.teamId ?? null) as string | null;
    k.lastTeamId = k.activeTeamId;
    return json(200, {});
  }
  if (url.pathname === "/v1/me/invites") return json(200, { invitations: [] });
  if (url.pathname === "/v1/me/preferences") {
    if (method === "PUT") k.preferences = { ...k.preferences, ...(body as Json) };
    return json(200, { preferences: k.preferences });
  }
  if (url.pathname === "/v1/notifications" || url.pathname === "/v1/notifications/read") {
    return notificationRoute(k, method, url);
  }
  if (url.pathname === "/v1/schedules") return json(200, { schedules: [], active_count: 0 });
  if (url.pathname === "/v1/team/models" && k.teamModels.length > 0) {
    if (headers.get("x-kobe-team") !== k.teamId) return error(409, "team_mismatch");
    const models = k.teamModels.map((m) => ({
      ...m,
      context_window: m.context_window ?? null,
      provider_id: "ollama",
      model: m.alias,
      gateway_model: `ollama/${m.alias}`,
      created_at: NOW,
      updated_at: NOW,
    }));
    return json(200, {
      models,
      default: k.teamModels.find((m) => m.is_default)?.alias ?? null,
    });
  }
  if (url.pathname === "/v1/agents/runnable") {
    if (headers.get("x-kobe-team") !== k.teamId) return error(409, "team_mismatch");
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const page = k.runnableAgents.slice(start, start + k.runnablePageSize);
    const next = start + page.length;
    return json(200, {
      agents: page.map((a) => ({
        slug: a.name.toLowerCase().replace(/\W+/g, "-"),
        current_version: 1,
        starters: [],
        ...a,
      })),
      next_cursor: next < k.runnableAgents.length ? String(next) : null,
    });
  }
  return undefined;
}

/** Answers its team-scoped paths; undefined for any other. */
export function teamAccountArea(k: FakeCore, req: FakeRequest): FakeAnswer {
  const { method, url } = req;
  const parts = url.pathname.split("/").filter(Boolean); // v1, area, id, action, sub
  const [, area, id] = parts;
  if (url.pathname === "/v1/team/budgets/status" && method === "GET") {
    return json(200, k.budgetStatus);
  }
  // The caller's project checkouts (Workspaces CM2, KOBE-581): none unless a test adds some.
  if (url.pathname === "/v1/me/checkouts" && method === "GET") {
    return json(200, { checkouts: k.checkouts });
  }
  if (url.pathname === "/v1/skills/drafts/saves" && method === "GET") {
    return json(200, {
      saves: k.skillDraftSaves.get(url.searchParams.get("threadId") ?? "") ?? [],
    });
  }
  if (area === "team" && id === "retention" && method === "GET") {
    return json(200, {
      period: "forever",
      maximum: "forever",
      effective: "forever",
      pending: null,
      upcoming: k.upcomingRetention,
      allowed: ["30d", "90d", "1y", "forever"],
    });
  }
  return undefined;
}
