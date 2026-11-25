import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BRANDING_SETTING_KEYS } from "@kaiju/protocol";
import { notifyUnmaintained } from "../skills/registry/maintainers.js";
import { notifySsoRequiredOff } from "../sso/required-notify.js";
import { openHarness, PUBLIC_URL, type Harness } from "../testing/harness.js";
import { appNameOnce, readMailAppName } from "./app-name.js";

/**
 * KOBE-834: emails read the Site's app name (Site console → Appearance) once per send and fall
 * back to the default name when it is unset or unreadable.
 */
let h: Harness;
const ownerEmail = "owner@app-name.test";

const setAppName = (value: string) =>
  h.admin.query(
    `INSERT INTO site_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [BRANDING_SETTING_KEYS.appName, value],
  );

const deps = () => ({ db: h.deps.database.db, mailer: h.mailer, publicUrl: PUBLIC_URL });

beforeAll(async () => {
  h = await openHarness();
  await h.createUser(ownerEmail, "owner");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await h.admin.query(`DELETE FROM site_settings WHERE key = $1`, [BRANDING_SETTING_KEYS.appName]);
  h.mailer.sent.length = 0;
});

describe("the Site's app name in emails (KOBE-834)", () => {
  it("falls back to the default name when unset", async () => {
    expect(await readMailAppName(h.deps.database.db)).toBe("Kaiju");
    expect(await notifySsoRequiredOff(deps(), "corp")).toBe(1);
    expect(h.mailer.to(ownerEmail)[0]?.subject).toBe("Kaiju: single sign-on is no longer required");
  });

  it("uses a custom app name in the subject", async () => {
    await setAppName("Acme Analytics");
    expect(await notifySsoRequiredOff(deps(), "corp")).toBe(1);
    await notifyUnmaintained(deps(), [{ id: "s", name: "pdf" }]);
    const subjects = h.mailer.to(ownerEmail).map((m) => m.subject);
    expect(subjects).toEqual([
      "Acme Analytics: single sign-on is no longer required",
      "Acme Analytics: catalog skills unmaintained",
    ]);
  });

  it("a stored name with CR/LF cannot inject a header: it falls back to the default", async () => {
    // Written past the API's validation (which refuses control characters).
    await setAppName("Acme\r\nBcc: victim@example.com");
    expect(await notifySsoRequiredOff(deps(), "corp")).toBe(1);
    const [mail] = h.mailer.to(ownerEmail);
    expect(mail?.subject).toBe("Kaiju: single sign-on is no longer required");
    expect(mail?.subject).not.toMatch(/[\r\n]/);
  });

  it("appNameOnce reads the name once for many sends", async () => {
    await setAppName("Acme");
    const read = appNameOnce(h.deps.database.db);
    const first = read();
    expect(read()).toBe(first);
    expect(await Promise.all([first, read()])).toEqual(["Acme", "Acme"]);
  });
});
