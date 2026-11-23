// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubApi, summary } from "../admin/testing";
import { IconActionProvider } from "../shell/icon-action";
import { NotificationBell } from "./notification-bell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const S1 = "00000000-0000-4000-8000-0000000005c1";
const T1 = "00000000-0000-4000-8000-00000000f001";
const T2 = "00000000-0000-4000-8000-00000000f002";
const N1 = "00000000-0000-4000-8000-00000000a001";
const N2 = "00000000-0000-4000-8000-00000000a002";
const N3 = "00000000-0000-4000-8000-00000000a003";
const COUNT = "GET /v1/notifications?unread=true&limit=1";
const ALL = "GET /v1/notifications?unread=false&limit=20";
const UNREAD = "GET /v1/notifications?unread=true&limit=20";
const MINE = "GET /v1/schedules?scope=mine";
const READ = "POST /v1/notifications/read";

const note = (id: string, over: Record<string, unknown> = {}) => ({
  notification_id: id,
  kind: "schedule.run.succeeded",
  schedule_id: S1,
  thread_id: T1,
  run_id: "00000000-0000-4000-8000-00000000b001",
  read_at: null,
  created_at: "2026-10-11T08:00:00Z",
  ...over,
});
const page = (notifications: unknown[], unread: number, next: string | null = null) => ({
  notifications,
  unread_count: unread,
  next_cursor: next,
});
const schedules = {
  schedules: [
    {
      schedule_id: S1,
      team_id: "t-1",
      user_id: "u-me",
      agent_id: "a",
      prompt: "Morning digest",
      recurrence: { kind: "daily", at: "09:00" },
      tz: "Europe/Berlin",
      active: true,
      notify_email: true,
      next_due_at: null,
      last_run_id: null,
      paused_by: null,
      created_at: "2026-10-01T10:00:00Z",
      updated_at: "2026-10-01T10:00:00Z",
    },
  ],
  active_count: 1,
};

/** Holds the answers to `keys` ("METHOD /path") until released; everything else as stubbed. */
function hold(...keys: string[]) {
  const base = globalThis.fetch;
  const gate = () => {
    let resolve = () => {};
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };
  const gates = new Map(keys.map((k) => [k, gate()] as const));
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    const gate = gates.get(`${init.method ?? "GET"} ${url}`);
    return gate ? gate.promise.then(() => base(url, init)) : base(url, init);
  });
  return (key: string) => gates.get(key)?.resolve();
}

function renderBell(onOpenThread = vi.fn()) {
  render(
    <IconActionProvider>
      <NotificationBell teamId="t-1" onOpenThread={onOpenThread} />
    </IconActionProvider>,
  );
  return onOpenThread;
}

const bell = () => screen.findByRole("button", { name: /^Notifications/ });

describe("notification bell (KOBE-181, ac-1)", () => {
  it("shows the unread count on the bell", async () => {
    stubApi({ [COUNT]: [200, page([note(N1)], 2)] });
    renderBell();
    await waitFor(async () =>
      expect((await bell()).getAttribute("aria-label")).toBe("Notifications, 2 unread"),
    );
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("has no badge when everything is read, and names the bell plainly", async () => {
    stubApi({ [COUNT]: [200, page([], 0)] });
    renderBell();
    await waitFor(async () =>
      expect((await bell()).getAttribute("aria-label")).toBe("Notifications"),
    );
  });

  it("opens the list: outcome, schedule by recurrence, link to the Scheduled thread", async () => {
    stubApi({
      [COUNT]: [200, page([note(N1)], 2)],
      [ALL]: [
        200,
        page(
          [
            note(N1, { kind: "schedule.run.skipped_actions", skipped_count: 2 }),
            note(N2, {
              kind: "schedule.run.failed",
              thread_id: T2,
              schedule_id: "00000000-0000-4000-8000-0000000005c9",
              read_at: "2026-10-11T09:00:00Z",
            }),
          ],
          1,
        ),
      ],
      [MINE]: [200, schedules],
    });
    const open = renderBell();
    const user = userEvent.setup();
    await user.click(await bell());
    const panel = within(await screen.findByRole("region", { name: "Notifications" }));
    await panel.findByText("Scheduled run finished; 2 actions were skipped");
    expect(panel.getByText(/^Every day at 09:00 \(Europe\/Berlin\) ·/)).toBeTruthy();
    expect(panel.getByText("Scheduled run failed")).toBeTruthy();
    expect(panel.getByText(/^A schedule that no longer exists ·/)).toBeTruthy();
    // Only the unread one offers "Mark read".
    expect(panel.getAllByRole("button", { name: /^Mark read/ })).toHaveLength(1);
    await user.click(
      panel.getAllByRole("button", { name: /^Open conversation/ })[1] as HTMLElement,
    );
    expect(open).toHaveBeenCalledWith(T2);
  });

  it("marks one read and updates the badge from the server's count", async () => {
    const calls = stubApi({
      [COUNT]: [200, page([note(N1)], 1)],
      [ALL]: [200, page([note(N1)], 1)],
      [MINE]: [200, schedules],
      [READ]: [200, { updated: 1, unread_count: 0 }],
    });
    renderBell();
    const user = userEvent.setup();
    await user.click(await bell());
    const panel = within(await screen.findByRole("region", { name: "Notifications" }));
    await user.click(await panel.findByRole("button", { name: /^Mark read/ }));
    await waitFor(async () =>
      expect((await bell()).getAttribute("aria-label")).toBe("Notifications"),
    );
    expect(panel.queryByRole("button", { name: /^Mark read/ })).toBeNull();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ notification_ids: [N1] });
  });

  it("opening an unread notification marks it read, then opens its thread", async () => {
    const calls = stubApi({
      [COUNT]: [200, page([note(N1)], 1)],
      [ALL]: [200, page([note(N1)], 1)],
      [MINE]: [200, schedules],
      [READ]: [200, { updated: 1, unread_count: 0 }],
    });
    const open = renderBell();
    const user = userEvent.setup();
    await user.click(await bell());
    const panel = within(await screen.findByRole("region", { name: "Notifications" }));
    await user.click(await panel.findByRole("button", { name: /^Open conversation/ }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(T1));
    expect(summary(calls)).toContain(READ);
  });

  it("marks all read", async () => {
    const calls = stubApi({
      [COUNT]: [200, page([note(N1)], 2)],
      [ALL]: [200, page([note(N1), note(N2)], 2)],
      [MINE]: [200, schedules],
      [READ]: [200, { updated: 2, unread_count: 0 }],
    });
    renderBell();
    const user = userEvent.setup();
    await user.click(await bell());
    const panel = within(await screen.findByRole("region", { name: "Notifications" }));
    await user.click(await panel.findByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(panel.queryAllByRole("button", { name: /^Mark read/ })).toEqual([]));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ all: true });
  });

  it("filters to unread and pages with the cursor", async () => {
    const calls = stubApi({
      [COUNT]: [200, page([note(N1)], 3)],
      [ALL]: [200, page([note(N1)], 3)],
      [UNREAD]: [200, page([note(N1)], 3, "c2")],
      [`${UNREAD}&cursor=c2`]: [200, page([note(N3, { kind: "schedule.run.interrupted" })], 3)],
      [MINE]: [200, schedules],
    });
    renderBell();
    const user = userEvent.setup();
    await user.click(await bell());
    const panel = within(await screen.findByRole("region", { name: "Notifications" }));
    await user.click(await panel.findByRole("checkbox", { name: "Unread only" }));
    await user.click(await panel.findByRole("button", { name: "Load more" }));
    await panel.findByText("Scheduled run was interrupted");
    expect(panel.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(summary(calls)).toEqual(expect.arrayContaining([UNREAD, `${UNREAD}&cursor=c2`]));
  });

  it("loads one more page at a time, keeps marks made meanwhile, and drops pages of an old filter", async () => {
    const calls = stubApi({
      [COUNT]: [200, page([note(N1)], 3)],
      [ALL]: [200, page([note(N1)], 3, "c2")],
      [`${ALL}&cursor=c2`]: [200, page([note(N2), note(N1)], 3)],
      [UNREAD]: [200, page([note(N3, { kind: "schedule.run.interrupted" })], 3)],
      [MINE]: [200, schedules],
      [READ]: [200, { updated: 1, unread_count: 2 }],
    });
    const release = hold(`${ALL}&cursor=c2`);
    renderBell();
    const user = userEvent.setup();
    await user.click(await bell());
    const panel = within(await screen.findByRole("region", { name: "Notifications" }));
    const more = await panel.findByRole("button", { name: "Load more" });
    await user.click(more);
    await user.click(more);
    await user.click(panel.getByRole("button", { name: /^Mark read/ }));
    release(`${ALL}&cursor=c2`);
    await waitFor(() => expect(panel.getAllByRole("listitem")).toHaveLength(2));
    expect(summary(calls).filter((c) => c === `${ALL}&cursor=c2`)).toHaveLength(1);
    // N1 was marked read while the page loaded: it stays read; N2 is new and unread.
    expect(panel.getAllByRole("button", { name: /^Mark read/ })).toHaveLength(1);

    // A page that answers after the filter changed is dropped.
    const release2 = hold(`${ALL}&cursor=c2`);
    await user.click(panel.getByRole("checkbox", { name: "Unread only" }));
    await panel.findByText("Scheduled run was interrupted");
    release2(`${ALL}&cursor=c2`);
    await waitFor(() => expect(panel.getAllByRole("listitem")).toHaveLength(1));
  });

  it("shows an error when loading more fails", async () => {
    stubApi({
      [COUNT]: [200, page([note(N1)], 1)],
      [ALL]: [200, page([note(N1)], 1, "c2")],
      [`${ALL}&cursor=c2`]: [400, { code: "invalid_request", message: "Unknown cursor." }],
      [MINE]: [200, schedules],
    });
    renderBell();
    const user = userEvent.setup();
    await user.click(await bell());
    const panel = within(await screen.findByRole("region", { name: "Notifications" }));
    await user.click(await panel.findByRole("button", { name: "Load more" }));
    expect((await panel.findByRole("alert")).textContent).toContain("Unknown cursor.");
  });

  it("names schedules neutrally until the caller's schedules have loaded", async () => {
    stubApi({
      [COUNT]: [200, page([note(N1)], 1)],
      [ALL]: [200, page([note(N1)], 1)],
      [MINE]: [200, schedules],
    });
    const release = hold(MINE);
    renderBell();
    const user = userEvent.setup();
    await user.click(await bell());
    const panel = within(await screen.findByRole("region", { name: "Notifications" }));
    expect(await panel.findByText(/^One of your schedules ·/)).toBeTruthy();
    expect(panel.queryByText(/no longer exists/)).toBeNull();
    release(MINE);
    expect(await panel.findByText(/^Every day at 09:00 \(Europe\/Berlin\) ·/)).toBeTruthy();
  });

  it("reads the list again on every open, the schedules only once", async () => {
    const calls = stubApi({
      [COUNT]: [200, page([], 0)],
      [ALL]: [200, page([note(N1, { read_at: "2026-10-11T09:00:00Z" })], 0)],
      [MINE]: [200, schedules],
    });
    renderBell();
    const user = userEvent.setup();
    await user.click(await bell());
    await screen.findByText("Scheduled run finished");
    await user.click(await bell());
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    await user.click(await bell());
    await screen.findByRole("region", { name: "Notifications" });
    await waitFor(() => expect(summary(calls).filter((c) => c === ALL)).toHaveLength(2));
    expect(summary(calls).filter((c) => c === MINE)).toHaveLength(1);
  });

  it("shows the server's message when the list fails", async () => {
    stubApi({
      [COUNT]: [200, page([], 0)],
      [ALL]: [400, { code: "invalid_request", message: "Unknown cursor." }],
      [MINE]: [200, schedules],
    });
    renderBell();
    const user = userEvent.setup();
    await user.click(await bell());
    expect((await screen.findByRole("alert")).textContent).toContain("Unknown cursor.");
  });
});

describe("a skill notification (KOBE-338)", () => {
  it("names the catalog skill and links to it, not to a conversation", async () => {
    stubApi({
      [COUNT]: [200, page([], 1)],
      [ALL]: [
        200,
        page(
          [
            note(N1, {
              kind: "skill.member_add.blocked",
              schedule_id: null,
              thread_id: null,
              run_id: null,
              skill_id: "00000000-0000-4000-8000-00000000c001",
              skill_name: "sales-report",
            }),
          ],
          1,
        ),
      ],
      [MINE]: [200, schedules],
      [READ]: [200, { updated: 1, unread_count: 0 }],
    });
    const onOpenSkill = vi.fn();
    render(
      <IconActionProvider>
        <NotificationBell teamId="t-1" onOpenThread={vi.fn()} onOpenSkill={onOpenSkill} />
      </IconActionProvider>,
    );
    await userEvent.click(await bell());
    const panel = await screen.findByRole("region", { name: "Notifications" });
    expect(
      await within(panel).findByText(
        "A Team admin blocked sales-report in this team; your Add for me was removed",
      ),
    ).toBeTruthy();
    expect(within(panel).getByText(/Catalog skill sales-report/)).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /Open conversation/ })).toBeNull();
    await userEvent.click(within(panel).getByRole("button", { name: /Open in the catalog/ }));
    await waitFor(() =>
      expect(onOpenSkill).toHaveBeenCalledWith(
        "/me/skills/catalog/00000000-0000-4000-8000-00000000c001",
      ),
    );
  });
});

describe("a memory notification (KOBE-645)", () => {
  it("names who proposed and deep-links to the proposal, marking it read", async () => {
    const P = "00000000-0000-4000-8000-00000000d001";
    stubApi({
      [COUNT]: [200, page([], 1)],
      [ALL]: [
        200,
        page(
          [
            note(N1, {
              kind: "memory.proposal.received",
              schedule_id: null,
              thread_id: null,
              run_id: null,
              memory_object_id: P,
              actor_name: "Ann",
            }),
          ],
          1,
        ),
      ],
      [MINE]: [200, schedules],
      [READ]: [200, { updated: 1, unread_count: 0 }],
    });
    const onOpenLink = vi.fn();
    render(
      <IconActionProvider>
        <NotificationBell teamId="t-1" onOpenThread={vi.fn()} onOpenLink={onOpenLink} />
      </IconActionProvider>,
    );
    await userEvent.click(await bell());
    const panel = await screen.findByRole("region", { name: "Notifications" });
    expect(await within(panel).findByText("Ann proposed a Workspace memory")).toBeTruthy();
    expect(within(panel).getByText(/Workspace memory ·/)).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /Open conversation/ })).toBeNull();
    await userEvent.click(within(panel).getByRole("button", { name: /Open the proposal/ }));
    await waitFor(() =>
      expect(onOpenLink).toHaveBeenCalledWith(`/admin/team/memory?proposal=${P}`),
    );
  });

  // KOBE-404: `confirmed` reaches the Site's curators and the proposer; each opens their own page.
  it.each([
    ["a Site steward", { site_role: null, site_grants: ["memory_steward"] }, "/admin/site/memory"],
    ["the proposer (a member)", { site_role: null, site_grants: [] }, "/me/memory"],
  ])("links a confirmed Site proposal for %s to a page they can open", async (_who, me, path) => {
    const P = "00000000-0000-4000-8000-00000000d002";
    stubApi({
      [COUNT]: [200, page([], 1)],
      [ALL]: [
        200,
        page(
          [
            note(N1, {
              kind: "memory.site_proposal.confirmed",
              schedule_id: null,
              thread_id: null,
              run_id: null,
              memory_object_id: P,
              actor_name: "Ann",
            }),
          ],
          1,
        ),
      ],
      [MINE]: [200, schedules],
      [READ]: [200, { updated: 1, unread_count: 0 }],
      "GET /v1/me": [200, { user: { id: "u1", name: "U", email: "u@x.io" }, ...me }],
      "GET /v1/team": [
        200,
        { team: { id: "t-1", slug: "t", name: "T" }, role: "member", permissions: [] },
      ],
    });
    const onOpenLink = vi.fn();
    render(
      <IconActionProvider>
        <NotificationBell teamId="t-1" onOpenThread={vi.fn()} onOpenLink={onOpenLink} />
      </IconActionProvider>,
    );
    await userEvent.click(await bell());
    const panel = await screen.findByRole("region", { name: "Notifications" });
    const label = path === "/me/memory" ? /Open My memory/ : /Open the Site proposal/;
    await userEvent.click(await within(panel).findByRole("button", { name: label }));
    await waitFor(() => expect(onOpenLink).toHaveBeenCalledWith(`${path}?site_proposal=${P}`));
  });
});

describe("a git notification (KOBE-819)", () => {
  const C = "00000000-0000-4000-8000-00000000e001";
  const P = "00000000-0000-4000-8000-00000000e002";
  const G = "00000000-0000-4000-8000-00000000e003";
  const git = { schedule_id: null, thread_id: null, run_id: null };

  it("tells the requester a conversion failed, with the reason, and opens the Files panel", async () => {
    stubApi({
      [COUNT]: [200, page([], 1)],
      [ALL]: [
        200,
        page(
          [
            note(N1, {
              ...git,
              kind: "git.conversion.failed",
              git_conversion_id: C,
              project_id: P,
              project_name: "Sales analysis",
              git_repository: "acme/sales-analysis",
              git_failure: "host_unreachable",
              git_failure_message: "The git host could not be reached. Retry shortly.",
            }),
          ],
          1,
        ),
      ],
      [MINE]: [200, schedules],
      [READ]: [200, { updated: 1, unread_count: 0 }],
    });
    const onOpenFiles = vi.fn();
    render(
      <IconActionProvider>
        <NotificationBell teamId="t-1" onOpenThread={vi.fn()} onOpenFiles={onOpenFiles} />
      </IconActionProvider>,
    );
    await userEvent.click(await bell());
    const panel = await screen.findByRole("region", { name: "Notifications" });
    expect(
      await within(panel).findByText("Converting Sales analysis to a Repo failed"),
    ).toBeTruthy();
    expect(
      within(panel).getByText("The git host could not be reached. Retry shortly."),
    ).toBeTruthy();
    expect(within(panel).getByText(/Repo acme\/sales-analysis ·/)).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /Open conversation/ })).toBeNull();
    await userEvent.click(within(panel).getByRole("button", { name: /Show in Files/ }));
    await waitFor(() => expect(onOpenFiles).toHaveBeenCalledWith(P));
  });

  it("tells an admin a token is nearing expiry and links to the Git section", async () => {
    stubApi({
      [COUNT]: [200, page([], 1)],
      [ALL]: [
        200,
        page(
          [
            note(N1, {
              ...git,
              kind: "git.connection.token_expiring",
              git_connection_id: G,
              git_connection_name: "Acme on GitHub",
              git_expires_at: "2026-10-20T00:00:00Z",
            }),
          ],
          1,
        ),
      ],
      [MINE]: [200, schedules],
      [READ]: [200, { updated: 1, unread_count: 0 }],
    });
    const onOpenLink = vi.fn();
    render(
      <IconActionProvider>
        <NotificationBell teamId="t-1" onOpenThread={vi.fn()} onOpenLink={onOpenLink} />
      </IconActionProvider>,
    );
    await userEvent.click(await bell());
    const panel = await screen.findByRole("region", { name: "Notifications" });
    expect(
      await within(panel).findByText(
        "The credential of the git connection Acme on GitHub expires on 2026-10-20",
      ),
    ).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: /Open the Git section/ }));
    await waitFor(() => expect(onOpenLink).toHaveBeenCalledWith("/admin/team/git"));
  });
});
