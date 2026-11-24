import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { ssoIdentities } from "@kobe/db";
import { PASSWORD, PUBLIC_URL } from "../testing/harness.js";
import {
  SCIM,
  SCIM_TYPE,
  PATCH_OP,
  ERROR,
  h,
  owner,
  ownerId,
  adminId,
  localId,
  providers,
  tokens,
  scim,
  auditRows,
  sessionFor,
  sessionExists,
  validatorUser,
  useScimHarness,
} from "./scim.test-helpers.js";

useScimHarness();

describe("Microsoft Entra's SCIM request sequence for Users (ac-1, ac-2)", () => {
  it("passes create → get by filter → PATCH attributes → active=false → GET → active=true → DELETE", async () => {
    const t = tokens.contoso;
    const suffix = randomUUID();
    const objectId = randomUUID();

    // Entra's probe: a random userName answers an empty list.
    const probe = await scim(
      "GET",
      `/contoso/Users?filter=${encodeURIComponent(`userName eq "${randomUUID()}"`)}`,
      t,
    );
    expect(probe.status).toBe(200);
    expect(probe.json).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 0,
      Resources: [],
    });

    // Create (validator-style body).
    const created = await scim("POST", "/contoso/Users", t, validatorUser(suffix, objectId));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.headers.get("content-type")).toContain(SCIM_TYPE);
    const id: string = created.json.id;
    expect(created.headers.get("location")).toBe(`${PUBLIC_URL}${SCIM}/contoso/Users/${id}`);
    expect(created.json).toMatchObject({
      externalId: objectId,
      userName: `Test_User_${suffix}`,
      active: true,
      displayName: "givenName familyName",
      emails: [{ value: `test_user_${suffix}@testuser.com`, type: "work", primary: true }],
    });
    // SSO9: no local credential; linked by externalId (objectId).
    const accounts = await h.admin.query("SELECT 1 FROM accounts WHERE user_id = $1", [id]);
    expect(accounts.rowCount).toBe(0);
    const link = await h.admin.query(
      "SELECT subject, linked_via FROM sso_identities WHERE user_id = $1",
      [id],
    );
    expect(link.rows).toEqual([{ subject: objectId, linked_via: "scim" }]);
    const createdAudit = (await auditRows("identity.scim.user.created")).at(-1);
    expect(createdAudit.actor_kind).toBe("system");
    expect(createdAudit.target).toMatchObject({ providerId: providers.contoso, userId: id });
    expect(createdAudit.target.credentialId).toEqual(expect.any(String));

    // A second create of the same user is a uniqueness conflict.
    const dup = await scim("POST", "/contoso/Users", t, validatorUser(suffix, objectId));
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ schemas: [ERROR], status: "409", scimType: "uniqueness" });

    // Get by filter (userName, any case) and by externalId, then by id.
    const byName = await scim(
      "GET",
      `/contoso/Users?filter=${encodeURIComponent(`userName eq "test_user_${suffix}"`)}`,
      t,
    );
    expect(byName.json.totalResults).toBe(1);
    expect(byName.json.Resources[0].id).toBe(id);
    const byExternal = await scim(
      "GET",
      `/contoso/Users?filter=${encodeURIComponent(`externalId eq "${objectId}"`)}&startIndex=1&count=10`,
      t,
    );
    expect(byExternal.json).toMatchObject({ totalResults: 1, startIndex: 1, itemsPerPage: 1 });
    expect((await scim("GET", `/contoso/Users/${id}`, t)).json.id).toBe(id);

    // PATCH multi-valued (emails[type eq "work"].value) and name.familyName.
    const multi = await scim("PATCH", `/contoso/Users/${id}`, t, {
      schemas: [PATCH_OP],
      Operations: [
        {
          op: "Replace",
          path: 'emails[type eq "work"].value',
          value: `updated_${suffix}@contoso.com`,
        },
        { op: "Replace", path: "name.familyName", value: "updatedFamilyName" },
      ],
    });
    expect(multi.status, JSON.stringify(multi.json)).toBe(200);
    expect(multi.json.emails[0].value).toBe(`updated_${suffix}@contoso.com`);
    // One name part alone keeps the name (Kaiju keeps a single name).
    expect(multi.json.displayName).toBe("givenName familyName");

    // PATCH single-valued: userName (now the UPN), and a path-less value object.
    const upn = `ann.${suffix}@contoso.com`;
    const single = await scim("PATCH", `/contoso/Users/${id}`, t, {
      schemas: [PATCH_OP],
      Operations: [
        { op: "Replace", path: "userName", value: upn },
        { op: "replace", value: { displayName: "Ann Lee", "name.givenName": "Ann", title: "Eng" } },
      ],
    });
    expect(single.status).toBe(200);
    expect(single.json).toMatchObject({ userName: upn, displayName: "Ann Lee" });
    expect(single.json.emails[0].value).toBe(upn);
    expect((await auditRows("identity.scim.user.updated")).length).toBeGreaterThanOrEqual(2);

    // active=false (as Entra sends it: path-less, "False") ends the sessions in the same request.
    const live = await sessionFor(id);
    const off = await scim("PATCH", `/contoso/Users/${id}`, t, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Replace", value: { active: "False" } }],
    });
    expect(off.status).toBe(200);
    expect(off.json.active).toBe(false);
    expect(await sessionExists(live)).toBe(false);
    const deact = await h.admin.query("SELECT deactivated_at FROM users WHERE id = $1", [id]);
    expect(deact.rows[0].deactivated_at).not.toBeNull();
    expect((await auditRows("identity.user.deactivated")).at(-1)).toMatchObject({
      actor_kind: "system",
      target: { userId: id },
    });
    expect((await auditRows("identity.scim.user.deactivated")).at(-1).target).toMatchObject({
      userId: id,
    });

    // GET shows it inactive; a session can't be created for it meanwhile.
    expect((await scim("GET", `/contoso/Users/${id}`, t)).json.active).toBe(false);

    // active=true reactivates.
    const on = await scim("PATCH", `/contoso/Users/${id}`, t, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Replace", path: "active", value: "True" }],
    });
    expect(on.json.active).toBe(true);
    expect((await auditRows("identity.scim.user.reactivated")).at(-1).target.userId).toBe(id);

    // DELETE deactivates and unlinks; the user row stays (Kaiju never deletes users).
    const del = await scim("DELETE", `/contoso/Users/${id}`, t);
    expect(del.status).toBe(204);
    expect((await scim("GET", `/contoso/Users/${id}`, t)).status).toBe(404);
    const after = await h.admin.query("SELECT deactivated_at FROM users WHERE id = $1", [id]);
    expect(after.rows[0].deactivated_at).not.toBeNull();
    expect(
      (await h.admin.query("SELECT 1 FROM sso_identities WHERE user_id = $1", [id])).rowCount,
    ).toBe(0);
    expect((await auditRows("identity.sso.link.removed")).at(-1).target).toMatchObject({
      userId: id,
      by: "scim",
    });
  });

  it("PUT replaces the resource; a provider sees only its own users", async () => {
    const t = tokens.contoso;
    const created = await scim("POST", "/contoso/Users", t, {
      userName: `bob.${randomUUID()}@contoso.com`,
      externalId: randomUUID(),
      displayName: "Bob",
    });
    expect(created.status).toBe(201);
    const put = await scim("PUT", `/contoso/Users/${created.json.id}`, t, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: created.json.userName,
      externalId: created.json.externalId,
      displayName: "Robert",
      active: true,
    });
    expect(put.status).toBe(200);
    expect(put.json.displayName).toBe("Robert");
    // fabrikam's token sees none of contoso's users.
    const other = await scim("GET", `/fabrikam/Users/${created.json.id}`, tokens.fabrikam);
    expect(other.status).toBe(404);
    const list = await scim("GET", "/fabrikam/Users", tokens.fabrikam);
    expect(list.json.totalResults).toBe(0);
    // A create with active "False" makes a deactivated user; a PUT without active keeps it so.
    const inactive = await scim("POST", "/contoso/Users", t, {
      userName: `eve.${randomUUID()}@contoso.com`,
      externalId: randomUUID(),
      active: "False",
    });
    expect(inactive.json.active).toBe(false);
    const kept = await scim("PUT", `/contoso/Users/${inactive.json.id}`, t, {
      userName: inactive.json.userName,
      externalId: inactive.json.externalId,
      displayName: "Eve",
    });
    expect(kept.json).toMatchObject({ active: false, displayName: "Eve" });
  });
});

describe("the site-role guard (SSO8, SSO10; ac-5)", () => {
  async function link(userId: string, subject = randomUUID()) {
    await h.deps.database.db.insert(ssoIdentities).values({
      providerId: providers.contoso ?? "",
      subject,
      userId,
      linkedVia: "jit",
    });
  }

  it("never deactivates the Owner or a site Admin; their SSO sessions end, local ones stay", async () => {
    await link(ownerId);
    await link(adminId);
    for (const userId of [ownerId, adminId]) {
      const sso = await sessionFor(userId, providers.contoso);
      const local = await sessionFor(userId);
      const res = await scim("PATCH", `/contoso/Users/${userId}`, tokens.contoso, {
        schemas: [PATCH_OP],
        Operations: [
          { op: "Replace", path: "active", value: "False" },
          { op: "Replace", path: "displayName", value: "Renamed" },
        ],
      });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ schemas: [ERROR], status: "403" });
      expect(res.json.detail).toMatch(/never deactivates the Owner, a site Admin/);
      const row = await h.admin.query("SELECT deactivated_at, name FROM users WHERE id = $1", [
        userId,
      ]);
      expect(row.rows[0].deactivated_at).toBeNull();
      expect(row.rows[0].name).not.toBe("Renamed");
      expect(await sessionExists(sso)).toBe(false);
      expect(await sessionExists(local)).toBe(true);
      expect((await auditRows("identity.scim.deactivation_refused")).at(-1).target).toMatchObject({
        providerId: providers.contoso,
        userId,
      });
      const del = await scim("DELETE", `/contoso/Users/${userId}`, tokens.contoso);
      expect(del.status).toBe(403);
      expect(
        (await h.admin.query("SELECT 1 FROM sso_identities WHERE user_id = $1", [userId])).rowCount,
      ).toBe(1);
    }
    // The Owner still signs in locally.
    await h.signIn("owner@scim.test");
  });

  it("protects the setup Owner even without a site role", async () => {
    const setup = await h.deps.createUserWithPassword(
      { email: "setup@scim.test", name: "Setup", password: PASSWORD },
      { recordSetup: true },
    );
    await link(setup.id);
    const res = await scim("PATCH", `/contoso/Users/${setup.id}`, tokens.contoso, {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(res.status).toBe(403);
  });

  it("never re-addresses an account that has a local password", async () => {
    await link(localId);
    const res = await scim("PATCH", `/contoso/Users/${localId}`, tokens.contoso, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Replace", path: "userName", value: "attacker@evil.example" }],
    });
    expect(res.status).toBe(200);
    expect(res.json.userName).toBe("attacker@evil.example");
    const row = await h.admin.query("SELECT email FROM users WHERE id = $1", [localId]);
    expect(row.rows[0].email).toBe("local@scim.test");
  });
});

describe("SCIM-created users and local credentials (SSO9; ac-6)", () => {
  it("can't sign in with a password, and a reset request sends nothing", async () => {
    const email = `carol.${randomUUID()}@contoso.com`;
    const created = await scim("POST", "/contoso/Users", tokens.contoso, {
      userName: email,
      externalId: randomUUID(),
      displayName: "Carol",
    });
    expect(created.status).toBe(201);
    const b = h.browser();
    const signIn = await b.post("/api/auth/sign-in/email", { email, password: PASSWORD });
    expect(signIn.status).not.toBe(200);
    const reset = await b.post("/api/auth/request-password-reset", { email });
    expect(reset.status).toBe(200);
    await h.mailer.settle();
    expect(h.mailer.to(email)).toEqual([]);
    const pending = await h.admin.query("SELECT 1 FROM verifications WHERE value = $1", [
      created.json.id,
    ]);
    expect(pending.rowCount).toBe(0);
    // A local user still gets their link.
    await b.post("/api/auth/request-password-reset", { email: "local@scim.test" });
    await h.mailer.settle();
    expect(h.mailer.to("local@scim.test").length).toBe(1);
  });

  it("never links on email: an existing local address is 409 uniqueness", async () => {
    const res = await scim("POST", "/contoso/Users", tokens.contoso, {
      userName: "admin@scim.test",
      externalId: randomUUID(),
    });
    expect(res.status).toBe(409);
    expect(res.json.scimType).toBe("uniqueness");
    expect(res.json.detail).toMatch(/expect an SSO link/);
  });
});

describe("SCIM errors and request limits", () => {
  it("answers RFC 7644 errors", async () => {
    const t = tokens.contoso;
    const bad = await scim("GET", `/contoso/Users?filter=${encodeURIComponent('name co "x"')}`, t);
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({
      schemas: [ERROR],
      status: "400",
      scimType: "invalidFilter",
      detail: expect.any(String),
    });
    const noUserName = await scim("POST", "/contoso/Users", t, { externalId: randomUUID() });
    expect(noUserName.json).toMatchObject({ status: "400", scimType: "invalidValue" });
    const noExternal = await scim("POST", "/contoso/Users", t, { userName: "x@contoso.com" });
    expect(noExternal.json).toMatchObject({ status: "400", scimType: "invalidValue" });
    const badOp = await scim("PATCH", `/contoso/Users/${randomUUID()}`, t, {
      Operations: [{ op: "explode" }],
    });
    expect(badOp.json).toMatchObject({ status: "400", scimType: "invalidSyntax" });
    expect((await scim("GET", `/contoso/Users/${randomUUID()}`, t)).status).toBe(404);
    expect((await scim("GET", "/contoso/Users/not-a-uuid", t)).status).toBe(404);
  });

  it("KOBE-775: answers 404 in SCIM form for 36-character ids that are not UUIDs", async () => {
    const t = tokens.contoso;
    for (const id of ["-".repeat(36), "a".repeat(36)]) {
      for (const method of ["GET", "DELETE"]) {
        const res = await scim(method, `/contoso/Users/${id}`, t);
        expect(res.status, `${method} ${id}`).toBe(404);
        expect(res.headers.get("content-type")).toContain(SCIM_TYPE);
        expect(res.json).toMatchObject({ schemas: [ERROR], status: "404" });
      }
      const filtered = await scim(
        "GET",
        `/contoso/Users?filter=${encodeURIComponent(`id eq "${id}"`)}`,
        t,
      );
      expect(filtered.status).toBe(200);
      expect(filtered.json.totalResults).toBe(0);
    }
  });

  it("requires a JSON body type and bounds the body size", async () => {
    const t = tokens.contoso;
    const form = await scim("POST", "/contoso/Users", t, "userName=x", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(form.status).toBe(415);
    const huge = await scim("POST", "/contoso/Users", t, {
      userName: "x@contoso.com",
      padding: "x".repeat(70 * 1024),
    });
    expect(huge.status).toBe(413);
    expect(huge.json.schemas).toEqual([ERROR]);
    const plainJson = await scim(
      "POST",
      "/contoso/Users",
      t,
      { userName: `dan.${randomUUID()}@contoso.com`, externalId: randomUUID() },
      { "content-type": "application/json" },
    );
    expect(plainJson.status).toBe(201);
  });
});

describe("security review fixes (KOBE-sso-review1)", () => {
  const patch = (path: string, value: unknown) => ({
    schemas: [PATCH_OP],
    Operations: [{ op: "Replace", path, value }],
  });

  it("marks a SCIM address verified only for an Entra UPN in a verified domain (finding 1)", async () => {
    await h.admin.query(
      `UPDATE sso_providers SET allowed_email_domains = '{contoso.com}' WHERE id = $1`,
      [providers.contoso],
    );
    try {
      const make = async (body: Record<string, unknown>) => {
        const res = await scim("POST", "/contoso/Users", tokens.contoso, {
          externalId: randomUUID(),
          ...body,
        });
        expect(res.status, JSON.stringify(res.json)).toBe(201);
        const row = await h.admin.query("SELECT email, email_verified FROM users WHERE id = $1", [
          res.json.id,
        ]);
        return { id: res.json.id as string, ...row.rows[0] };
      };
      const upn = await make({ userName: `upn.${randomUUID()}@Contoso.com` });
      expect(upn.email_verified).toBe(true);
      const outside = await make({ userName: `x.${randomUUID()}@kobe-victim.test` });
      expect(outside.email_verified).toBe(false);
      const fromMail = await make({
        userName: `not-an-address-${randomUUID()}`,
        emails: [{ type: "work", value: `m.${randomUUID()}@contoso.com` }],
      });
      expect(fromMail.email_verified).toBe(false);
      // A re-address follows the same rule.
      const moved = await scim(
        "PATCH",
        `/contoso/Users/${upn.id}`,
        tokens.contoso,
        patch("userName", `moved.${randomUUID()}@kobe-victim.test`),
      );
      expect(moved.status).toBe(200);
      const after = await h.admin.query("SELECT email_verified FROM users WHERE id = $1", [upn.id]);
      expect(after.rows[0].email_verified).toBe(false);
    } finally {
      await h.admin.query(`UPDATE sso_providers SET allowed_email_domains = '{}' WHERE id = $1`, [
        providers.contoso,
      ]);
    }
  });

  it("keeps externalId immutable once set, even for a site Admin (finding 2)", async () => {
    const subject = randomUUID();
    await h.deps.database.db.insert(ssoIdentities).values({
      providerId: providers.fabrikam ?? "",
      subject,
      userId: adminId,
      linkedVia: "jit",
    });
    const sso = await sessionFor(adminId, providers.fabrikam);
    const res = await scim(
      "PATCH",
      `/fabrikam/Users/${adminId}`,
      tokens.fabrikam,
      patch("externalId", randomUUID()),
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ status: "400", scimType: "mutability" });
    const put = await scim("PUT", `/fabrikam/Users/${adminId}`, tokens.fabrikam, {
      userName: "admin@scim.test",
      externalId: randomUUID(),
    });
    expect(put.status).toBe(400);
    expect(put.json.scimType).toBe("mutability");
    const link = await h.admin.query(
      "SELECT subject FROM sso_identities WHERE user_id = $1 AND provider_id = $2",
      [adminId, providers.fabrikam],
    );
    expect(link.rows).toEqual([{ subject }]);
    expect(await sessionExists(sso)).toBe(true);
    // The same value (any case, for an Entra GUID) is no change.
    const same = await scim(
      "PATCH",
      `/fabrikam/Users/${adminId}`,
      tokens.fabrikam,
      patch("externalId", subject.toUpperCase()),
    );
    expect(same.status).toBe(200);
  });

  it("reactivates only users SCIM deactivated; an admin's deactivation stands (SSO11)", async () => {
    const t = tokens.contoso;
    const created = await scim("POST", "/contoso/Users", t, {
      userName: `fay.${randomUUID()}@contoso.com`,
      externalId: randomUUID(),
    });
    const id: string = created.json.id;
    const via = async () =>
      (await h.admin.query("SELECT deactivated_via FROM users WHERE id = $1", [id])).rows[0]
        .deactivated_via;

    // SCIM off, SCIM on: fine.
    expect((await scim("PATCH", `/contoso/Users/${id}`, t, patch("active", false))).status).toBe(
      200,
    );
    expect(await via()).toBe(`scim:${providers.contoso}`);
    const on = await scim("PATCH", `/contoso/Users/${id}`, t, patch("active", true));
    expect(on.json.active).toBe(true);
    expect(await via()).toBeNull();

    // A site admin deactivates: SCIM can't undo it.
    expect((await owner.post(`/v1/site/users/${id}/deactivate`)).status).toBe(200);
    expect(await via()).toBe("admin");
    const refused = await scim("PATCH", `/contoso/Users/${id}`, t, patch("active", true));
    expect(refused.status).toBe(403);
    expect(refused.json.detail).toMatch(/deactivated by a site admin/);
    const row = await h.admin.query("SELECT deactivated_at FROM users WHERE id = $1", [id]);
    expect(row.rows[0].deactivated_at).not.toBeNull();
    expect((await auditRows("identity.scim.reactivation_refused")).at(-1).target).toMatchObject({
      providerId: providers.contoso,
      userId: id,
    });
    const put = await scim("PUT", `/contoso/Users/${id}`, t, {
      userName: created.json.userName,
      externalId: created.json.externalId,
      active: true,
    });
    expect(put.status).toBe(403);

    // The admin reactivates; SCIM deactivates; the admin deactivates again (takes it over).
    expect((await owner.post(`/v1/site/users/${id}/reactivate`)).status).toBe(200);
    await scim("PATCH", `/contoso/Users/${id}`, t, patch("active", false));
    expect((await owner.post(`/v1/site/users/${id}/deactivate`)).status).toBe(200);
    expect(await via()).toBe("admin");
    expect((await scim("PATCH", `/contoso/Users/${id}`, t, patch("active", true))).status).toBe(
      403,
    );

    // A user SCIM created inactive is SCIM's to activate.
    const inactive = await scim("POST", "/contoso/Users", t, {
      userName: `gil.${randomUUID()}@contoso.com`,
      externalId: randomUUID(),
      active: false,
    });
    const gil = await scim("PATCH", `/contoso/Users/${inactive.json.id}`, t, patch("active", true));
    expect(gil.json.active).toBe(true);
  });

  it("protects the setup Owner by a durable flag, not by an audit row (finding 8)", async () => {
    // The setup Owner made earlier in this file (recordSetup) carries the flag.
    const flagged = await h.admin.query<{ email: string }>(
      "SELECT email FROM users WHERE setup_owner",
    );
    expect(flagged.rows).toEqual([{ email: "setup@scim.test" }]);
    // At most one user carries it (partial unique index, re-review C).
    const second = await h.createUser(`second.${randomUUID()}@scim.test`);
    await expect(
      h.admin.query("UPDATE users SET setup_owner = true WHERE id = $1", [second]),
    ).rejects.toMatchObject({ code: "23505" });
    // A setup Owner with no audit row at all (e.g. the log was pruned) stays protected.
    const bare = await h.createUser(`bare.${randomUUID()}@scim.test`);
    await h.admin.query("UPDATE users SET setup_owner = false WHERE setup_owner");
    await h.admin.query("UPDATE users SET setup_owner = true WHERE id = $1", [bare]);
    await h.deps.database.db.insert(ssoIdentities).values({
      providerId: providers.contoso ?? "",
      subject: randomUUID(),
      userId: bare,
      linkedVia: "jit",
    });
    const res = await scim(
      "PATCH",
      `/contoso/Users/${bare}`,
      tokens.contoso,
      patch("active", false),
    );
    expect(res.status).toBe(403);
    const row = await h.admin.query("SELECT deactivated_at FROM users WHERE id = $1", [bare]);
    expect(row.rows[0].deactivated_at).toBeNull();
  });

  it("re-checks who deactivated under the row lock when reactivating (re-review B)", async () => {
    const t = tokens.contoso;
    const created = await scim("POST", "/contoso/Users", t, {
      userName: `race.${randomUUID()}@contoso.com`,
      externalId: randomUUID(),
      active: false,
    });
    const id: string = created.json.id;
    // An admin's deactivation is in flight (row locked, not yet committed) when SCIM reactivates.
    const admin = new pg.Client({ connectionString: h.adminUrl });
    await admin.connect();
    try {
      await admin.query("BEGIN");
      await admin.query("UPDATE users SET deactivated_via = 'admin' WHERE id = $1", [id]);
      const pending = scim("PATCH", `/contoso/Users/${id}`, t, patch("active", true));
      await expect
        .poll(async () => {
          const r = await h.admin.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND datname = current_database()`,
          );
          return r.rows[0].n as number;
        })
        .toBeGreaterThan(0);
      await admin.query("COMMIT");
      const res = await pending;
      expect(res.status).toBe(403);
      const row = await h.admin.query(
        "SELECT deactivated_at, deactivated_via FROM users WHERE id = $1",
        [id],
      );
      expect(row.rows[0].deactivated_at).not.toBeNull();
      expect(row.rows[0].deactivated_via).toBe("admin");
    } finally {
      await admin.end();
    }
  });
});
