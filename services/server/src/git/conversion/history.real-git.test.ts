import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AddressPolicy } from "@kaiju/address-policy";
import { withTestLoopback } from "@kaiju/address-policy/testing";
import { GitHostError } from "../../git-hosts/adapter.js";
import { gitWireClient, gitWireSession } from "../../git-hosts/git-wire.js";
import type { GitHostNet } from "../../git-hosts/http.js";
import { gitHostTarget } from "../../git-hosts/target.js";
import { startGitServer, type GitServer } from "../../testing/git-http-server.js";
import {
  buildHistory,
  ConversionStepError,
  initRepository,
  type HistorySource,
  type SourceFile,
} from "./objects.js";
import type { ConversionPlan } from "./plan.js";
import { pushHistory, readRemote, resumeIndex } from "./push.js";

/**
 * KOBE-765 (GIT-9) against a real `git http-backend`: the conversion's history is built with
 * isomorphic-git, pushed in batches through the guarded smart-HTTP client (pinned address,
 * Basic credential, only the repository's endpoints) to a bare repository that runs
 * `receive.fsckObjects`, then checked with `git fsck` and `git log`. Also: the same plan gives the
 * same hashes, an interrupted push resumes after the last batch, and a branch someone else wrote
 * to stops the attempt.
 */
const CREDS = { username: "kobe-bot", token: "conversion-test-token" };
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const text = (s: string) => new TextEncoder().encode(s);

let server: GitServer;
let work: string;
let port: number;
/** The server under a made-up name: the policy resolves it to 127.0.0.1 and pins that address. */
let origin: string;

beforeAll(async () => {
  server = await startGitServer({ credentials: CREDS });
  port = Number(new URL(server.origin).port);
  origin = `http://git.fake.test:${port}`;
  work = await mkdtemp(path.join(tmpdir(), "kaiju-conversion-test-"));
});

afterAll(async () => {
  await server.close();
  await rm(work, { recursive: true, force: true });
});

const net: GitHostNet = {
  policy: {
    allowHttp: true,
    allowedPorts: [] as number[],
    allowedInternalCidrs: [],
    deniedCidrs: [],
    resolve: () => Promise.resolve(["127.0.0.1"]),
    addresses: withTestLoopback(),
  },
};
const policyFor = (p: number): GitHostNet => ({
  ...net,
  policy: { ...net.policy, allowedPorts: [p] },
});

/** A small project: a README, a script made executable, a file deleted later, a nested file. */
const blobs = new Map<string, Uint8Array>();
function file(p: string, content: string, executable = false): SourceFile {
  const bytes = text(content);
  const digest = sha(bytes);
  blobs.set(digest, bytes);
  return { path: p, sha256: digest, size: bytes.length, executable, blobRef: `k/${digest}` };
}
const trees: Record<string, SourceFile[]> = {
  c1: [file("README.md", "# Demo\n")],
  c2: [file("README.md", "# Demo\n\nMore.\n"), file("bin/run.sh", "#!/bin/sh\necho hi\n", true)],
  c3: [file("bin/run.sh", "#!/bin/sh\necho hi\n", true), file("docs/a/b.txt", "deep\n")],
};
const source: HistorySource = {
  loadTree: (id) => Promise.resolve(id === null ? [] : (trees[id] ?? [])),
  readFile: (f) => {
    const b = blobs.get(f.sha256);
    if (!b) throw new ConversionStepError("content_missing", f.path);
    return Promise.resolve(b);
  },
};
const ada = { name: "Ada Lovelace", email: "ada@example.test" };
const adaVia = { name: "Ada Lovelace via Kaiju", email: "ada@example.test" };
const bob = { name: "Bob", email: "1a2b3c4d5e+bob@users.noreply.kaiju.test" };
const plan: ConversionPlan = {
  v: 1,
  branch: "main",
  history: true,
  headCommitId: null,
  commits: [
    {
      kobeCommitId: "c1",
      seq: 1,
      message: "Start\n",
      time: 1_700_000_000,
      author: ada,
      committer: adaVia,
    },
    {
      kobeCommitId: "c2",
      seq: 2,
      message: "Add the script\n\nWith a body line.\n",
      time: 1_700_000_100,
      author: bob,
      committer: { ...bob, name: "Bob via Kaiju" },
    },
    {
      kobeCommitId: "c3",
      seq: 3,
      message: "Tidy up\n",
      time: 1_700_000_200,
      author: ada,
      committer: adaVia,
    },
  ],
};

async function freshBuild(name: string) {
  const gitdir = path.join(work, name);
  await initRepository(gitdir, "main");
  return { gitdir, built: await buildHistory(gitdir, plan, source) };
}

function clientFor(repo: string, password = CREDS.token) {
  const url = `${origin}/${repo}.git`;
  const target = gitHostTarget({ enabled: true, allowedHosts: [] }, origin, {
    allowHttp: true,
  });
  return {
    url,
    ...((session) => ({ session, http: session.http }))(
      gitWireSession({
        net: policyFor(port),
        target,
        repositoryUrl: url,
        credential: { username: CREDS.username, password },
        maxRequestBytes: 64 * 1024 * 1024,
      }),
    ),
  };
}

const bare = (repo: string, args: string[]) => server.git(repo, args, { bare: true });

describe("conversion history on a real git server", () => {
  it("pushes every commit with its author, committer, time and message; fsck is clean", async () => {
    server.repo("acme/demo");
    bare("acme/demo", ["config", "receive.fsckObjects", "true"]);
    const { gitdir, built } = await freshBuild("one");
    expect(built.commits).toHaveLength(3);
    const { url, http, session } = clientFor("acme/demo");
    const pushed: number[] = [];
    // 1-byte batches: one push per commit, each a fast-forward.
    await pushHistory({
      gitdir,
      session: () => Promise.resolve(session),
      packFile: path.join(work, `push-${Math.random().toString(16).slice(2)}.pack`),
      url,
      branch: "main",
      built,
      from: resumeIndex(built, await readRemote(http, url, "main")),
      batchBytes: 1,
      onPushed: (n) => {
        pushed.push(n);
        return Promise.resolve();
      },
    });
    expect(pushed).toEqual([1, 2, 3]);
    expect(bare("acme/demo", ["rev-parse", "refs/heads/main"]).trim()).toBe(built.commits[2]);
    bare("acme/demo", ["fsck", "--strict", "--no-dangling"]);
    const log = bare("acme/demo", [
      "log",
      "--reverse",
      "--format=%an|%ae|%cn|%ce|%at|%ct|%s",
      "main",
    ]).trim();
    expect(log.split("\n")).toEqual([
      "Ada Lovelace|ada@example.test|Ada Lovelace via Kaiju|ada@example.test|1700000000|1700000000|Start",
      `Bob|${bob.email}|Bob via Kaiju|${bob.email}|1700000100|1700000100|Add the script`,
      "Ada Lovelace|ada@example.test|Ada Lovelace via Kaiju|ada@example.test|1700000200|1700000200|Tidy up",
    ]);
    expect(bare("acme/demo", ["log", "-1", "--format=%B", "main~1"]).trim()).toBe(
      "Add the script\n\nWith a body line.",
    );
    // Trees: deletions, the executable bit and nested folders as git sees them.
    expect(
      bare("acme/demo", ["ls-tree", "-r", "--format=%(objectmode) %(path)", "main"]).trim(),
    ).toBe("100755 bin/run.sh\n100644 docs/a/b.txt");
    expect(bare("acme/demo", ["show", "main~2:README.md"])).toBe("# Demo\n");
    // Only the repository's endpoints were asked for, each with the Basic credential.
    for (const r of server.requests.filter((q) => q.url.includes("acme/demo"))) {
      expect(r.url).toMatch(
        /^\/acme\/demo\.git\/(info\/refs\?service=git-receive-pack|git-receive-pack)$/,
      );
      expect(r.authorization).toBe(
        `Basic ${Buffer.from(`${CREDS.username}:${CREDS.token}`).toString("base64")}`,
      );
    }
  });

  it("pushes a commit larger than a batch as its own batch, streamed from disk", async () => {
    server.repo("acme/large");
    bare("acme/large", ["config", "receive.fsckObjects", "true"]);
    const big = new Uint8Array(12 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 2654435761) >>> 24;
    const digest = sha(big);
    blobs.set(digest, big);
    const huge: SourceFile = {
      path: "data/big.bin",
      sha256: digest,
      size: big.length,
      executable: false,
      blobRef: "k/big",
    };
    trees.big = [file("README.md", "# Demo\n"), huge];
    const largePlan: ConversionPlan = {
      ...plan,
      commits: [
        plan.commits[0],
        { ...plan.commits[1], kobeCommitId: "big" },
      ] as ConversionPlan["commits"],
    };
    const gitdir = path.join(work, "large");
    await initRepository(gitdir, "main");
    const built = await buildHistory(gitdir, largePlan, source);
    expect(built.newBytes[1]).toBeGreaterThan(12 * 1024 * 1024 - 1);
    const { url, session } = clientFor("acme/large");
    const pushed: number[] = [];
    await pushHistory({
      gitdir,
      session: () => Promise.resolve(session),
      packFile: path.join(work, "large.pack"),
      url,
      branch: "main",
      built,
      from: 0,
      batchBytes: 1024 * 1024,
      onPushed: (n) => {
        pushed.push(n);
        return Promise.resolve();
      },
    });
    expect(pushed).toEqual([1, 2]);
    bare("acme/large", ["fsck", "--strict", "--no-dangling"]);
    expect(bare("acme/large", ["cat-file", "-s", "main:data/big.bin"]).trim()).toBe(
      String(big.length),
    );
  });

  it("builds the same hashes every time (a retry recognises what the host has)", async () => {
    const a = await freshBuild("det-a");
    const b = await freshBuild("det-b");
    expect(b.built.commits).toEqual(a.built.commits);
    expect(a.built.newBytes[0]).toBe(7);
  });

  it("resumes an interrupted push after the last batch the host took", async () => {
    server.repo("acme/resume");
    const { gitdir, built } = await freshBuild("resume");
    const { url, http, session } = clientFor("acme/resume");
    const crash = new Error("crash after the first batch");
    await expect(
      pushHistory({
        gitdir,
        session: () => Promise.resolve(session),
        packFile: path.join(work, `push-${Math.random().toString(16).slice(2)}.pack`),
        url,
        branch: "main",
        built,
        from: 0,
        batchBytes: 1,
        onPushed: () => Promise.reject(crash),
      }),
    ).rejects.toBe(crash);
    expect(bare("acme/resume", ["rev-parse", "main"]).trim()).toBe(built.commits[0]);
    // A new attempt, with a fresh local repository built from the same plan.
    const again = await freshBuild("resume-2");
    const from = resumeIndex(again.built, await readRemote(http, url, "main"));
    expect(from).toBe(1);
    await pushHistory({
      gitdir: again.gitdir,
      session: () => Promise.resolve(session),
      packFile: path.join(work, `push-${Math.random().toString(16).slice(2)}.pack`),
      url,
      branch: "main",
      built: again.built,
      from,
      batchBytes: 1024 * 1024,
      onPushed: () => Promise.resolve(),
    });
    expect(bare("acme/resume", ["rev-parse", "main"]).trim()).toBe(built.commits[2]);
    expect(bare("acme/resume", ["rev-list", "--count", "main"]).trim()).toBe("3");
    bare("acme/resume", ["fsck", "--strict", "--no-dangling"]);
  });

  it("stops when the branch holds commits that are not the plan's", async () => {
    server.repo("acme/foreign");
    const empty = bare("acme/foreign", ["hash-object", "-t", "tree", "-w", "--stdin"]).trim();
    const other = bare("acme/foreign", ["commit-tree", empty, "-m", "someone else"]).trim();
    bare("acme/foreign", ["update-ref", "refs/heads/main", other]);
    const { built } = await freshBuild("foreign");
    const { url, http } = clientFor("acme/foreign");
    const remote = await readRemote(http, url, "main");
    expect(remote.head).not.toBeNull();
    expect(() => resumeIndex(built, remote)).toThrow(ConversionStepError);
    try {
      resumeIndex(built, remote);
    } catch (err) {
      expect((err as ConversionStepError).code).toBe("repository_changed");
    }
  });

  it("refuses a wrong credential, other paths and other hosts", async () => {
    server.repo("acme/locked");
    const { url, http } = clientFor("acme/locked", "wrong");
    await expect(readRemote(http, url, "main")).rejects.toMatchObject({ name: "HttpError" });
    // Only the repository's own endpoints: another repository is refused before sending.
    const before = server.requests.length;
    await expect(
      http.request({ url: `${origin}/acme/other.git/info/refs?service=git-receive-pack` }),
    ).rejects.toBeInstanceOf(GitHostError);
    await expect(
      http.request({ url: `${origin}/acme/locked.git/objects/info/packs` }),
    ).rejects.toBeInstanceOf(GitHostError);
    await expect(
      http.request({
        url: `http://127.0.0.1:${port}/acme/locked.git/info/refs?service=git-receive-pack`,
      }),
    ).rejects.toBeInstanceOf(GitHostError);
    expect(server.requests.length).toBe(before);
  });

  it("refuses an address the policy does not allow, before connecting", async () => {
    const url = `${origin}/acme/demo.git`;
    const http = gitWireClient({
      // No loopback in the address check: 127.0.0.1 is refused.
      net: { policy: { ...policyFor(port).policy, addresses: new AddressPolicy() } },
      target: gitHostTarget({ enabled: true, allowedHosts: [] }, origin, { allowHttp: true }),
      repositoryUrl: url,
      credential: { username: "u", password: "p" },
      maxRequestBytes: 1024,
    });
    const before = server.requests.length;
    await expect(readRemote(http, url, "main")).rejects.toMatchObject({ code: "host_refused" });
    expect(server.requests.length).toBe(before);
  });
});
