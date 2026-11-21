/** Artifacts (KOBE-55 D-6, KOBE-485) and shared files (KOBE-150) (KOBE-717 area). */
import { artifactFileExtension } from "@kobe/protocol";
import type { FakeCore } from "./core";
import {
  error,
  FAKE_FRAME_CSP,
  json,
  NOW,
  type FakeAnswer,
  type FakeArtifact,
  type FakeRequest,
} from "./state";

export function artifactRoute(k: FakeCore, method: string, url: URL, headers: Headers): Response {
  const [, , id, , n, leaf] = url.pathname.split("/").filter(Boolean); // v1 artifacts id versions n leaf
  const isFrame = leaf === "frame";
  const team = isFrame ? url.searchParams.get("team") : headers.get("x-kobe-team");
  // Downloads (content with ?team=) also carry the team in the query.
  const teamOk = team === k.teamId || url.searchParams.get("team") === k.teamId;
  if (!teamOk) return error(409, "team_mismatch");
  const summary = (a: FakeArtifact) => ({
    id: a.id,
    thread_id: a.thread_id,
    kind: a.kind,
    title: a.title,
    language: a.language,
    current_version: a.versions.length,
    created_at: NOW,
    updated_at: NOW,
  });
  if (id === undefined) {
    const threadId = url.searchParams.get("thread_id");
    const list = [...k.artifacts.values()].filter((a) => a.thread_id === threadId);
    return json(200, { artifacts: list.map(summary) });
  }
  const artifact = k.artifacts.get(id);
  if (!artifact) return error(404, "not_found");
  if (n === undefined) {
    const versions = artifact.versions.map((c, i) => ({
      version: i + 1,
      size_bytes: new TextEncoder().encode(c).length,
      created_at: NOW,
    }));
    return json(200, { ...summary(artifact), versions });
  }
  const content = artifact.versions[Number(n) - 1];
  if (content === undefined) return error(404, "not_found");
  if (leaf === "edit-as-file" && method === "POST") return editAsFile(k, artifact, content);
  if (isFrame) {
    if (artifact.kind !== "html" && artifact.kind !== "svg") return error(404, "not_found");
    return new Response(content, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": FAKE_FRAME_CSP,
        "x-frame-options": "SAMEORIGIN",
        "referrer-policy": "no-referrer",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return new Response(content, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${artifact.title}-v${n}.txt"`,
    },
  });
}

/**
 * `POST /v1/artifacts/:id/versions/:n/edit-as-file` (KOBE-485): the version copied into the
 * workspace as `artifacts/<slug>.<ext>`, `-2`, `-3` … on a clash; a reader's thread answers 403.
 */
export function editAsFile(k: FakeCore, artifact: FakeArtifact, content: string): Response {
  if (k.threads.get(artifact.thread_id)?.read_only === true) return error(403, "read_only");
  const stem = artifact.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const ext = artifactFileExtension(artifact.kind, artifact.language);
  let path = `artifacts/${stem}.${ext}`;
  for (let n = 2; k.workspaceFiles.has(path); n += 1) path = `artifacts/${stem}-${n}.${ext}`;
  const bytes = new TextEncoder().encode(content);
  k.workspaceFiles.set(path, bytes);
  return json(201, {
    name: path.split("/").at(-1),
    path,
    type: "file",
    size_bytes: bytes.length,
    mtime: NOW,
    source: "synced",
    owner: "server",
    area: "workspace",
  });
}

/** Answers its paths; undefined for any other. */
export function artifactsArea(k: FakeCore, req: FakeRequest): FakeAnswer {
  const { method, url, headers } = req;
  if (url.pathname.startsWith("/v1/artifacts")) return artifactRoute(k, method, url, headers);
  const shared = /^\/v1\/files\/([^/]+)\/content$/u.exec(url.pathname);
  if (shared) {
    const file = k.sharedFiles.get(shared[1] ?? "");
    if (!file) return error(404, "not_found");
    if (file.status !== 200) return error(file.status, "unavailable");
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return undefined;
}
