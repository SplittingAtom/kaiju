import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTestLoopback } from "@kobe/address-policy/testing";
import { GIT_MIRROR_LOG_MAX } from "@kobe/db";
import { gitWireClient } from "../../git-hosts/git-wire.js";
import type { GitHostNet } from "../../git-hosts/http.js";
import { gitHostTarget } from "../../git-hosts/target.js";
import { commitOnHost, symlinkOnHost } from "../../testing/git-host-commits.js";
import { startGitServer, type GitServer } from "../../testing/git-http-server.js";
import { fetchBranch, MirrorError, remoteHead } from "./fetch.js";
import { largestPackedObject } from "./pack-sizes.js";

/**
 * KOBE-766 (GIT-10) against a real `git http-backend`: the mirror reads the host's head through
 * the guarded smart-HTTP client, fetches the default branch shallowly, lists the head's files
 * (symlinks left out), the newest commits as plain text, and refuses an object over the size cap
 * from the pack headers before inflating it.
 */
const CREDS = { username: "kobe-bot", token: "mirror-test-token" };
let server: GitServer;
let work: string;
let origin: string;
let n = 0;

beforeAll(async () => {
  server = await startGitServer({ credentials: CREDS });
  origin = `http://git.fake.test:${new URL(server.origin).port}`;
  work = await mkdtemp(path.join(tmpdir(), "kobe-mirror-test-"));
});

afterAll(async () => {
  await server.close();
  await rm(work, { recursive: true, force: true });
});

function client(name: string) {
  const net: GitHostNet = {
    policy: {
      allowHttp: true,
      allowedPorts: [Number(new URL(server.origin).port)],
      allowedInternalCidrs: [],
      deniedCidrs: [],
      resolve: () => Promise.resolve(["127.0.0.1"]),
      addresses: withTestLoopback(),
    },
  };
  const target = gitHostTarget({ enabled: true, allowedHosts: [] }, origin, { allowHttp: true });
  const url = `${origin}/acme/${name}.git`;
  const http = gitWireClient({
    net,
    target,
    repositoryUrl: url,
    credential: { username: CREDS.username, password: CREDS.token },
    maxRequestBytes: 1024 * 1024,
  });
  return { http, url };
}

const caps = { maxFiles: 500, maxFileBytes: 1024 * 1024, slug: "demo" };
const fresh = () => {
  n += 1;
  const name = `r${n}`;
  server.repo(`acme/${name}`);
  return name;
};

describe("remoteHead and fetchBranch", () => {
  it("reads the head, the files and the newest commits", async () => {
    const name = fresh();
    const { http, url } = client(name);
    expect(await remoteHead(http, url, "main")).toBeNull();
    commitOnHost(server.root, `acme/${name}`, { "README.md": "# Hi\n" }, "Start");
    commitOnHost(
      server.root,
      `acme/${name}`,
      { "bin/run.sh": "#!/bin/sh\n", "docs/a/b.txt": "deep\n" },
      "Add a script\n\nWith a body.",
    );
    const head = symlinkOnHost(server.root, `acme/${name}`, "link", "README.md");
    expect(await remoteHead(http, url, "main")).toBe(head);
    const got = await fetchBranch(http, url, "main", path.join(work, name), caps);
    expect(got.head).toBe(head);
    expect(got.skipped).toBe(1);
    expect(got.files.map((f) => [f.path, f.executable])).toEqual([
      ["README.md", false],
      ["bin/run.sh", true],
      ["docs/a/b.txt", false],
    ]);
    const readme = got.files[0];
    expect(Buffer.from(await got.readBlob(readme?.oid ?? "")).toString()).toBe("# Hi\n");
    expect(got.commits.map((c) => [c.message, c.authorName])).toEqual([
      ["Add a link", "Hana Host"],
      ["Add a script", "Hana Host"],
      ["Start", "Hana Host"],
    ]);
    expect(got.commits[0]?.sha).toBe(head);
    expect(JSON.stringify(got.commits)).not.toContain("hana@example.org");
  });

  it("keeps at most the newest commits", async () => {
    const name = fresh();
    const { http, url } = client(name);
    for (let i = 0; i < GIT_MIRROR_LOG_MAX + 3; i += 1) {
      commitOnHost(server.root, `acme/${name}`, { "n.txt": String(i) }, `Commit ${i}`);
    }
    const got = await fetchBranch(http, url, "main", path.join(work, name), caps);
    expect(got.commits).toHaveLength(GIT_MIRROR_LOG_MAX);
    expect(got.commits[0]?.message).toBe(`Commit ${GIT_MIRROR_LOG_MAX + 2}`);
  });

  it("refuses too many files, a path Kobe cannot hold and an oversized object", async () => {
    const name = fresh();
    const { http, url } = client(name);
    commitOnHost(server.root, `acme/${name}`, { "a.txt": "a", "b.txt": "b" }, "Two");
    await expect(
      fetchBranch(http, url, "main", path.join(work, `${name}-1`), { ...caps, maxFiles: 1 }),
    ).rejects.toMatchObject({ code: "too_many_files" });
    commitOnHost(server.root, `acme/${name}`, { "back\\slash.txt": "x" }, "Backslash");
    await expect(
      fetchBranch(http, url, "main", path.join(work, `${name}-2`), caps),
    ).rejects.toMatchObject({ code: "unsupported_path" });

    const big = fresh();
    const c = client(big);
    // Zeros compress to almost nothing: the pack is small, the object is not.
    commitOnHost(server.root, `acme/${big}`, { "zeros.bin": Buffer.alloc(4 * 1024 * 1024) }, "Big");
    const err = await fetchBranch(c.http, c.url, "main", path.join(work, big), caps).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MirrorError);
    expect(err).toMatchObject({ code: "file_too_large", detail: String(4 * 1024 * 1024) });
  });

  it("reads delta objects' sizes from the pack headers", async () => {
    const name = fresh();
    const { http, url } = client(name);
    const base = randomBytes(64 * 1024).toString("hex");
    commitOnHost(server.root, `acme/${name}`, { "f.txt": base }, "One");
    commitOnHost(server.root, `acme/${name}`, { "f.txt": `${base}more` }, "Two");
    server.git(`acme/${name}`, ["repack", "-a", "-d", "-f"], { bare: true });
    const dir = path.join(work, name);
    await fetchBranch(http, url, "main", dir, caps);
    expect(await largestPackedObject(path.join(dir, ".git"))).toBe(base.length + 4);
  });

  it("names a missing branch", async () => {
    const name = fresh();
    const { http, url } = client(name);
    commitOnHost(server.root, `acme/${name}`, { "a.txt": "a" }, "One");
    await expect(
      fetchBranch(http, url, "trunk", path.join(work, name), caps),
    ).rejects.toMatchObject({ code: "branch_missing" });
  });
});
