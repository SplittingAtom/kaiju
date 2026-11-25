import { describe, expect, it } from "vitest";
import { requestMessage } from "../egress/request-notify.js";
import {
  driftMessage,
  skippedMessage,
  templatesSkippedMessage,
} from "../connectors/drift-notify.js";
import { shorteningMessage } from "../retention/notify.js";
import { defaultNoticeMessage } from "../skills/default-notify.js";
import { suspensionMessage } from "../skills/rescan-notify.js";
import { ssoRequiredOffMessage } from "../sso/required-notify.js";
import { mailAppName } from "./app-name.js";
import type { MailMessage } from "./mailer.js";
import { passwordResetMessage, scheduledRunMessage } from "./messages.js";

/** KOBE-834: subjects and bodies name the Site by its app name, cleaned for mail headers. */

const URL = "https://kaiju.test";
const NO_HEADER_BREAK = /[\r\n\u0085\u2028\u2029]/;

/** Every builder that names the product, with the given app name. */
function messages(app: string): MailMessage[] {
  const detail = {
    team: "Finance",
    domain: "pypi.org",
    pattern: "pypi.org",
    threadId: null,
    requester: "Alice",
    scope: "team" as const,
  };
  return [
    ssoRequiredOffMessage(URL, "corp", "a@b.test", "last_provider", app),
    suspensionMessage(
      URL,
      [{ skillId: "s", version: 2, slug: "pdf", authorId: "u", scope: "personal" }],
      new Map(),
      "a@b.test",
      app,
    ),
    defaultNoticeMessage(URL, "pdf", "Finance", { kind: "removed" }, "a@b.test", app),
    defaultNoticeMessage(
      URL,
      "pdf",
      "Finance",
      { kind: "added", installed: true },
      "a@b.test",
      app,
    ),
    shorteningMessage({
      appName: app,
      to: "a@b.test",
      teamName: "Finance",
      period: "90d",
      effectiveAt: new Date("2026-12-01T00:00:00Z"),
      threads: 3,
      appUrl: URL,
    }),
    requestMessage(URL, "requested", detail, "a@b.test", app),
    requestMessage(URL, "requested", { ...detail, scope: "site" }, "a@b.test", app),
    driftMessage(
      URL,
      { name: "linear", tools: ["a"], templates: ["ui://x"], invalid: [] },
      "a@b.test",
      app,
    ),
    skippedMessage(URL, { name: "linear", source: "site" }, "a@b.test", app),
    templatesSkippedMessage(URL, { name: "linear", reason: "proxy_outdated" }, "a@b.test", app),
    passwordResetMessage({ appName: app, to: "a@b.test", link: `${URL}/r`, expiresInMinutes: 30 }),
    scheduledRunMessage({
      appName: app,
      to: "a@b.test",
      outcome: "succeeded",
      teamName: "Finance",
      when: null,
      skippedCount: null,
      threadLink: `${URL}/t`,
      schedulesLink: `${URL}/s`,
    }),
  ];
}

describe("mailAppName", () => {
  it("keeps a plain name", () => {
    expect(mailAppName("Acme Analytics")).toBe("Acme Analytics");
  });

  it("falls back to the default name when unset or empty", () => {
    expect(mailAppName(undefined)).toBe("Kaiju");
    expect(mailAppName(null)).toBe("Kaiju");
    expect(mailAppName("")).toBe("Kaiju");
    expect(mailAppName(" \r\n\t ")).toBe("Kaiju");
  });

  it("cannot break a header: CR, LF, NEL, separators and bidi controls become spaces", () => {
    const name = mailAppName("Acme\r\nBcc: victim@example.com\u0085\u2028X\u202Ey");
    expect(name).not.toMatch(NO_HEADER_BREAK);
    expect(name).not.toContain("\u202E");
    expect(name).toBe("Acme Bcc: victim@example.com X y");
  });

  it("caps the name at 40 characters without splitting a surrogate pair", () => {
    expect(mailAppName("x".repeat(500))).toBe("x".repeat(40));
    const emoji = mailAppName("🙂".repeat(41));
    expect([...emoji]).toHaveLength(40);
    expect(emoji).toBe("🙂".repeat(40));
  });
});

describe("product name in subjects and bodies (KOBE-834)", () => {
  it("uses the Site's custom app name and never the built-in one", () => {
    for (const m of messages("Acme")) {
      expect(`${m.subject}\n${m.text}`, m.subject).not.toContain("Kaiju");
    }
    const [sso, suspended, removed, added] = messages("Acme");
    expect(sso?.subject).toBe("Acme: single sign-on is no longer required");
    expect(suspended?.subject).toBe("Acme: skills suspended after a scanner update");
    expect(removed?.subject).toBe("Acme: pdf is no longer a default skill");
    expect(added?.subject).toBe("Acme: pdf is now a default skill");
    const bodies = messages("Acme").map((m) => m.text);
    expect(bodies.some((t) => t.includes("team on Acme will keep conversations"))).toBe(true);
    expect(bodies.some((t) => t.includes("sandboxes on Acme."))).toBe(true);
    expect(bodies.some((t) => t.includes("disabled in Acme until"))).toBe(true);
    expect(bodies.some((t) => t.includes("Acme's MCP proxy is older"))).toBe(true);
  });

  it("names the default app when the name is empty", () => {
    const [sso] = messages("");
    expect(sso?.subject).toBe("Kaiju: single sign-on is no longer required");
  });

  it("CR/LF in the app name cannot inject a header", () => {
    for (const m of messages("Acme\r\nBcc: victim@example.com")) {
      expect(m.subject, m.subject).not.toMatch(NO_HEADER_BREAK);
      expect(m.text).not.toContain("\r");
      expect(m.text).not.toMatch(/^Bcc:/m);
    }
    expect(messages("Acme\r\nBcc: victim@example.com")[0]?.subject).toBe(
      "Acme Bcc: victim@example.com: single sign-on is no longer required",
    );
  });
});
