// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { PortableBreakGlassPage } from "./site/portable-break-glass-page";
import { ME, answerConfirm, forbidNativeConfirm, renderSite, stubApi, summary } from "./testing";

const USERS = {
  users: [
    {
      id: "u-bob",
      name: "Bob",
      email: "b@x.io",
      siteRole: null,
      twoFactorEnabled: false,
      deactivatedAt: null,
      createdAt: "",
    },
  ],
};

const grant = (over: Record<string, unknown> = {}) => ({
  id: "g-1",
  subject: { id: "u-bob", name: "Bob", email: "b@x.io" },
  requestedBy: { id: "u-inv", name: "Ivy", email: "i@x.io" },
  approvedBy: null,
  decidedBy: null,
  reason: "HR case 12",
  legalHold: false,
  durationMinutes: 60,
  status: "pending",
  selfApproved: false,
  requestedAt: "2026-11-13T10:00:00Z",
  requestExpiresAt: "2026-11-14T10:00:00Z",
  decidedAt: null,
  startsAt: null,
  expiresAt: null,
  endedAt: null,
  actions: { approve: true, deny: true, revoke: true, read: false },
  ...over,
});

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("site portable memory break-glass page (KOBE-648)", () => {
  it("requests access to one person's portable memories with reason, duration and legal hold", async () => {
    const calls = stubApi({
      "GET /v1/site/portable-break-glass": [200, { grants: [], selfApprovalAllowed: false }],
      "GET /v1/site/users": [200, USERS],
      "POST /v1/site/portable-break-glass": [201, { grant: grant(), notified: { recipients: 1 } }],
    });
    renderSite(<PortableBreakGlassPage />);
    const form = await screen.findByRole("form", { name: "Request access to portable memories" });
    await userEvent.selectOptions(within(form).getByLabelText("Person"), "u-bob");
    await userEvent.selectOptions(within(form).getByLabelText("Duration"), "120");
    await userEvent.type(within(form).getByLabelText("Reason"), "HR case 12: complaint");
    await userEvent.click(within(form).getByLabelText(/Legal hold/));
    await userEvent.click(within(form).getByRole("button", { name: "Request access" }));
    await screen.findByText(/A second site admin must approve it/);
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      subjectUserId: "u-bob",
      reason: "HR case 12: complaint",
      durationMinutes: 120,
      legalHold: true,
    });
  });

  it("approves after confirming, naming the person", async () => {
    const calls = stubApi({
      "GET /v1/site/portable-break-glass": [200, { grants: [grant()], selfApprovalAllowed: false }],
      "GET /v1/site/users": [200, USERS],
      "POST /v1/site/portable-break-glass/g-1/approve": [
        200,
        { grant: grant({ status: "active" }), notified: { recipients: 2 } },
      ],
    });
    renderSite(<PortableBreakGlassPage />);
    const row = (await screen.findByText("HR case 12")).closest("tr") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Approve" }));
    await answerConfirm(/^Approve access to Bob's portable memories/, "Approve");
    await screen.findByText(/Active: Bob/);
    expect(summary(calls)).toContain("POST /v1/site/portable-break-glass/g-1/approve");
  });

  it("reads the person's portable memories under an own active grant", async () => {
    const active = grant({
      requestedBy: { id: ME.id, name: ME.name, email: ME.email },
      status: "active",
      startsAt: "2026-11-13T10:00:00Z",
      expiresAt: "2026-11-13T11:00:00Z",
      actions: { approve: false, deny: false, revoke: true, read: true },
    });
    stubApi({
      "GET /v1/site/portable-break-glass": [200, { grants: [active], selfApprovalAllowed: false }],
      "GET /v1/site/users": [200, USERS],
      "GET /v1/site/portable-break-glass/g-1/items": [
        200,
        {
          grant: { id: "g-1", subject_user_id: "u-bob", expires_at: "", workspaces: 2 },
          items: [
            {
              id: "i-1",
              kind: "preference",
              status: "active",
              superseded_by: null,
              pinned: true,
              tags: ["style"],
              current_version: 1,
              statement: "Bob prefers short answers",
              created_at: "2026-11-01T00:00:00Z",
              updated_at: "2026-11-01T00:00:00Z",
            },
          ],
          next_after: null,
        },
      ],
    });
    renderSite(<PortableBreakGlassPage />);
    const row = (await screen.findByText("HR case 12")).closest("tr") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Read" }));
    await screen.findByText("Bob prefers short answers");
    expect(screen.getByText(/Recorded in 2 Workspace audit view/)).toBeTruthy();
  });
});
