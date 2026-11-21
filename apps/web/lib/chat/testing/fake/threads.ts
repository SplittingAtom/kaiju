/** Thread lists, search and creation, and the thread folders (KOBE-717 area). */
import { launch } from "./apps";
import type { FakeCore } from "./core";
import {
  error,
  json,
  matchedEntry,
  NOW,
  type FakeAnswer,
  type FakeRequest,
  type Json,
} from "./state";
import { threadAction, threadItself } from "./thread-actions";
import { connectorsAnswer } from "./thread-settings";

export function threadRoute(
  k: FakeCore,
  method: string,
  id: string | undefined,
  action: string | undefined,
  sub: string | undefined,
  url: URL,
  body: Json | undefined,
  headers: Headers,
): Response {
  if (id === "file-links" && method === "GET") {
    return k.fileLinks.route(url) ?? error(404, "not_found");
  }
  if (id === undefined && method === "GET") {
    const q = url.searchParams.get("q");
    // KOBE-534 (TF5): `none` = own unfiled; a folder id = its threads the caller reads.
    const folder = url.searchParams.get("folder");
    const list = [...k.threads.values()]
      .filter((t) => t.deleted_at === null && t.is_test !== true)
      // The activity list leaves out pinned and archived threads; search finds them (CE19).
      .filter((t) => q !== null || (!t.pinned_at && !t.archived_at))
      // ... and others' shared threads, which have their own list (CE20, KOBE-221).
      .filter((t) => q !== null || t.read_only !== true || (folder !== null && folder !== "none"))
      .filter(
        (t) =>
          folder === null ||
          (folder === "none" ? (t.folder_id ?? null) === null : t.folder_id === folder),
      )
      .filter(
        (t) =>
          q === null ||
          (t.title ?? "").toLowerCase().includes(q.toLowerCase()) ||
          matchedEntry(t, q) !== null,
      )
      .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
    const threads = list.map((t) =>
      q === null
        ? k.summary(t)
        : {
            ...k.summary(t),
            // Like the server: the matching message, which may be on an inactive branch.
            matched_entry_id: (t.title ?? "").toLowerCase().includes(q.toLowerCase())
              ? null
              : matchedEntry(t, q),
            snippet: [{ text: t.title, highlight: true }],
            score: 1,
          },
    );
    return json(200, { threads, next_cursor: null });
  }
  if ((id === "pinned" || id === "archived") && method === "GET") {
    const key = id === "pinned" ? "pinned_at" : "archived_at";
    const folder = id === "pinned" ? url.searchParams.get("folder") : null;
    const list = [...k.threads.values()]
      .filter((t) => t.deleted_at === null && t.is_test !== true && t[key])
      .filter(
        (t) =>
          folder === null ||
          (folder === "none" ? (t.folder_id ?? null) === null : t.folder_id === folder),
      )
      .sort((a, b) => String(b[key]).localeCompare(String(a[key])));
    return json(200, { threads: list.map((t) => k.summary(t)), next_cursor: null });
  }
  if (id === "shared" && method === "GET") {
    const list = [...k.threads.values()]
      .filter((t) => t.deleted_at === null && t.read_only === true)
      .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
    return json(200, { threads: list.map((t) => k.summary(t)), next_cursor: null });
  }
  if (id === "activity" && method === "GET") {
    // KOBE-301: the caller's own live threads with a run going; `approval` when one waits.
    const active = [...k.threads.values()].filter(
      (t) =>
        t.deleted_at === null &&
        t.read_only !== true &&
        t.is_test !== true &&
        t.status === "running",
    );
    return json(200, {
      threads: active.map((t) => ({
        thread_id: t.thread_id,
        activity: k.awaitsApproval(t.thread_id) ? "approval" : "running",
      })),
    });
  }
  if (id === "trash" && method === "GET") {
    const trash = [...k.threads.values()].filter((t) => t.deleted_at !== null);
    return json(200, { threads: trash.map((t) => k.summary(t)), next_cursor: null });
  }
  if (id === "test" && method === "DELETE") {
    const agent = url.searchParams.get("agent_id");
    const mine = [...k.threads.values()].filter(
      (t) =>
        t.is_test === true && t.deleted_at === null && (agent === null || t.agent_id === agent),
    );
    for (const t of mine) t.deleted_at = NOW;
    return json(200, { cleared: mine.length });
  }
  if (id === "connectors" && method === "GET") return connectorsAnswer(k, null);
  if (id === "skills" && method === "GET") {
    return json(200, { skills: k.chatSkills.map((name) => ({ name })) });
  }
  if (id === "app-cards" && method === "POST") {
    const app = k.teamApps.find((a) => a.appId === body?.app_id);
    if (!app) return error(404, "app_not_available", "This app is not available to you.");
    // Like the server (KOBE-458): the new thread pins the agent a new conversation starts with.
    const threadId = k.addThread(app.title as string);
    // The new-conversation view's choice when sent (null: No agent), else the default.
    const preset =
      body?.agent_id === undefined
        ? k.runnableAgents.find((a) => a.default === true)
        : k.runnableAgents.find((a) => a.id === body.agent_id);
    if (preset) {
      Object.assign(k.thread(threadId), {
        agent_id: preset.id,
        agent_model: preset.model,
        agent_name: preset.name,
        agent_status: "active",
      });
    }
    return launch(k, threadId, body?.app_id);
  }
  if (id === undefined && method === "POST") {
    const model = (body?.model as string | null | undefined) ?? null;
    if (model !== null && !k.modelEnabled(model)) return k.modelNotEnabled();
    const threadId = k.addThread((body?.title as string | undefined) ?? null);
    k.thread(threadId).model = model;
    if (typeof body?.thinking_level === "string") {
      k.thread(threadId).thinking_level = body.thinking_level;
    }
    if (body?.test === true) {
      Object.assign(k.thread(threadId), { is_test: true, agent_id: body.agent_id ?? null });
    } else if (typeof body?.skill_draft_id === "string") {
      Object.assign(k.thread(threadId), { skill_draft_id: body.skill_draft_id });
    } else if (typeof body?.agent_id === "string") {
      const agent = k.runnableAgents.find((a) => a.id === body.agent_id);
      if (!agent) return error(404, "agent_not_found", "No agent with that id.");
      Object.assign(k.thread(threadId), {
        agent_id: agent.id,
        agent_model: agent.model,
        agent_name: agent.name,
        agent_status: "active",
      });
    }
    if (typeof body?.project_id === "string") {
      k.thread(threadId).project_id = body.project_id;
    }
    return json(201, k.summary(k.thread(threadId)));
  }
  const thread = id === undefined ? undefined : k.threads.get(id);
  if (!thread) return error(404, "thread_not_found", "No thread with that id.");
  if (action === undefined) return threadItself(k, method, thread, url, body);
  return threadAction(k, method, thread, action, sub, url, body, headers);
}

/** Answers its team-scoped paths; undefined for any other. */
export function threadsArea(k: FakeCore, req: FakeRequest): FakeAnswer {
  const { method, url, headers } = req;
  const body = req.body;
  const parts = url.pathname.split("/").filter(Boolean); // v1, area, id, action, sub
  const [, area, id, action, sub] = parts;
  if (area === "threads") return threadRoute(k, method, id, action, sub, url, body, headers);
  if (area === "thread-folders") return k.folders.route(method, id, body);
  return undefined;
}
