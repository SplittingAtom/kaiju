import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvelope, sealGitCredential, type Envelope } from "@kobe/db";
import { runGitContextSchema } from "@kobe/protocol/sandbox-wire";
import { loadRunGitContext } from "./git/sandbox-git.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-764: the member's `run.start.git` read from the database: name and Kobe email (or the
 * Workspace's no-reply form, GQ10), and the connections the sandbox's git may use. The sealed
 * credential is never read and never in the result.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const TOKEN_SECRET = "ghp_FAKEfakeFAKEfakeFAKEfake0764";
const team = randomUUID();
const otherTeam = randomUUID();
let h: Harness;
let envelope: Envelope;
let member = "";
let email = "";

async function addConnection(
  teamId: string,
  baseUrl: string,
  organization: string,
  access = "read_write",
) {
  const id = randomUUID();
  const sealed = sealGitCredential(
    envelope,
    { teamId, connectionId: id },
    { kind: "access_token", token: TOKEN_SECRET },
  );
  await h.admin.query(
    `INSERT INTO git_connections (team_id, id, provider, base_url, organization, display_name,
       credential_kind, credential_sealed, credential_key_id, credential_hint, access_level,
       created_by)
     VALUES ($1, $2, 'forgejo', $3, $4, 'Acme', 'access_token', $5, $6, '••••0764', $7, $8)`,
    [
      teamId,
      id,
      baseUrl,
      organization,
      sealed.credentialSealed,
      sealed.credentialKeyId,
      access,
      member,
    ],
  );
}

beforeAll(async () => {
  envelope = must(loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) }));
  h = await openHarness({ envelope });
  for (const [id, slug] of [
    [team, "gs"],
    [otherTeam, "gx"],
  ] as const) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
      id,
      `${slug}-${id.slice(0, 6)}`,
    ]);
  }
  email = `ada-${team.slice(0, 6)}@git.test`;
  member = await h.createUser(email);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'contributor')`,
    [team, member],
  );
  await addConnection(team, "https://git.example.test/forgejo", "acme");
  await addConnection(team, "https://off.example.test", "acme", "off");
  await addConnection(otherTeam, "https://other.example.test", "theirs");
});

afterAll(async () => {
  await h?.close();
});

describe("loadRunGitContext (KOBE-764)", () => {
  it("gives the member as author with their Kobe email and this Workspace's connections only", async () => {
    const git = must(
      await loadRunGitContext(h.deps.database.db, { teamId: team, userId: member }, "kobe.test"),
    );
    const name = email.split("@")[0] as string;
    expect(git).toEqual({
      author: { name, email },
      committer: { name: `${name} via Kobe`, email },
      remotes: [{ base_url: "https://git.example.test/forgejo", organization: "acme" }],
    });
    expect(runGitContextSchema.safeParse(git).success).toBe(true);
    expect(JSON.stringify(git)).not.toContain(TOKEN_SECRET);
  });

  it("uses the no-reply form once the Workspace setting says so (GQ10)", async () => {
    await h.admin.query(
      `UPDATE teams SET settings = settings || '{"git_commit_email": "noreply"}'::jsonb WHERE id = $1`,
      [team],
    );
    const git = must(
      await loadRunGitContext(h.deps.database.db, { teamId: team, userId: member }, "kobe.test"),
    );
    expect(git.author.email).toBe(`${member}@users.noreply.kobe.test`);
    expect(git.committer.email).toBe(`${member}@users.noreply.kobe.test`);
    expect(JSON.stringify(git)).not.toContain(email);
  });

  it("is undefined for an unknown member", async () => {
    expect(
      await loadRunGitContext(
        h.deps.database.db,
        { teamId: team, userId: randomUUID() },
        "kobe.test",
      ),
    ).toBeUndefined();
  });
});
