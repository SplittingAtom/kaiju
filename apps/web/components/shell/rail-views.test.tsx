// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKaiju } from "../../lib/chat/testing/fake-kaiju";
import { PREFERENCES_PATH } from "../../lib/shell/preferences";
import { must } from "../../lib/testing/must";
import { browseApps, composer, openApp, pressModShift, showFilesFromApps } from "../chat/testing";

/**
 * The rail's one section shows Files or Apps (KOBE-448). Since KOBE-844 (Chris 2026-11-25) there
 * are no Files | Apps tabs: Browse apps (the + menu, Mod+Shift+X, the palette) opens Apps, and
 * Files comes back with the Apps view's Show files, Mod+Shift+F, `/files` or the palette. The view
 * is remembered per member (`rail_tab`), Files the first time; without apps (and no key to add)
 * the section is Files alone.
 */
let fake: FakeKaiju;
const WAIT = { timeout: 10_000 };
/** Lets effects and any late request started by a switch run, so "no new wake" is a real check. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const APP = {
  appId: "a".repeat(64),
  connectorId: "11111111-1111-4111-8111-111111111111",
  connectorName: "Catalyst",
  iconUrl: null,
  tool: "open_lakehouse_explorer",
  title: "Lakehouse Explorer",
  uri: "ui://catalyst/lakehouse-explorer",
  sha256: "e".repeat(64),
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKaiju();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "Workspace" });
const filesEl = () => must(document.getElementById("kaiju-rail-files"));
const appsEl = () => document.getElementById("kaiju-rail-apps");
const puts = () => fake.requests.filter((r) => r.method === "PUT" && r.path === PREFERENCES_PATH);

async function withApps() {
  fake.teamApps = [APP];
  openApp(fake);
  await composer();
  await waitFor(() => must(appsEl()), WAIT);
}

describe("Files or Apps, no tabs (KOBE-844)", () => {
  it("starts on Files; Browse apps shows Apps; Show files goes back; each keeps its state", async () => {
    await withApps();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    const files = within(rail()).getByRole("region", { name: "Files" });
    expect(files.hidden).toBe(false);
    await within(files).findByRole("button", { name: "Refresh files" }, WAIT);
    const apps = await browseApps();
    expect(apps.hidden).toBe(false);
    expect(files.hidden).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(apps));
    // No app list under the Pickers section since KOBE-559 (launches go through the + menu).
    expect(within(apps).queryByRole("button", { name: /^Open Lakehouse Explorer/ })).toBeNull();
    showFilesFromApps();
    await waitFor(() => expect(files.hidden).toBe(false));
    expect(must(appsEl()).hidden).toBe(true);
    // Kept mounted: still listed.
    expect(within(files).getByRole("button", { name: "Refresh files" })).toBeTruthy();
  });

  it("lists nothing on a load on Apps; Files lists the first time it shows (KOBE-461 ac-2)", async () => {
    fake.preferences = { rail_tab: "apps" };
    const wakes = () =>
      fake.requests.filter(
        (r) =>
          r.method === "POST" &&
          (r.path === "/v1/workspace/wake" || r.path === "/v1/workspace/sync"),
      ).length;
    const listings = () => fake.workspaceListings.length;
    await withApps();
    await waitFor(() => expect(appsEl()?.hidden).toBe(false));
    await waitFor(() => expect(rail().hasAttribute("data-settled")).toBe(true), WAIT);
    expect(wakes()).toBe(0);
    expect(listings()).toBe(0);
    showFilesFromApps();
    await waitFor(() => expect(wakes()).toBe(1), WAIT);
    await waitFor(() => expect(listings()).toBe(1), WAIT);
    await browseApps();
    await settle();
    expect(wakes()).toBe(1);
  });

  it("remembers the member's view across loads (another device too)", async () => {
    await withApps();
    await browseApps();
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ rail_tab: "apps" }), WAIT);
    act(() => cleanup());
    openApp(fake);
    await composer();
    await waitFor(() => expect(appsEl()?.hidden).toBe(false), WAIT);
    expect(filesEl().hidden).toBe(true);
  });

  it("Mod+Shift+F goes back to Files from Apps", async () => {
    fake.preferences = { rail_tab: "apps" };
    await withApps();
    await waitFor(() => expect(appsEl()?.hidden).toBe(false));
    act(() => void pressModShift("F"));
    await waitFor(() => expect(filesEl().hidden).toBe(false));
    await waitFor(() => expect(document.activeElement?.id).toBe("kaiju-rail-files"));
  });

  it("the toggle on the top line says Files and apps, and hiding it hides both", async () => {
    await withApps();
    const toggle = within(rail()).getByRole("button", { name: "Files and apps" });
    await userEvent.setup().click(toggle);
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    expect(screen.queryByRole("region", { name: "Apps" })).toBeNull();
  });
});

describe("no apps", () => {
  it("the section is Files, whatever view was stored; Browse apps says why it can't", async () => {
    fake.preferences = { rail_tab: "apps" };
    openApp(fake);
    await composer();
    await waitFor(
      () => expect(within(rail()).getByRole("region", { name: "Files" }).hidden).toBe(false),
      WAIT,
    );
    expect(appsEl()).toBeNull();
    act(() => void pressModShift("X"));
    await settle();
    expect(appsEl()).toBeNull();
    expect(filesEl().hidden).toBe(false);
  });

  it("a key to add is enough for the Apps view", async () => {
    fake.teamAppsNeedKey = [
      { connectorId: APP.connectorId, connectorName: "Catalyst", title: "Lakehouse Explorer" },
    ];
    openApp(fake);
    await composer();
    const apps = await browseApps();
    expect(within(apps).getByRole("link", { name: /Add your key/ })).toBeTruthy();
  });
});

describe("the collapsed rail", () => {
  it("has one icon for the section, opening it on the last view", async () => {
    fake.preferences = { rail_collapsed: true, rail_tab: "apps" };
    await withApps();
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    const strip = must(rail().querySelector<HTMLElement>("[class*='icons']"));
    const labels = [...strip.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels.filter((l) => l === "Show files" || l === "Show apps")).toEqual(["Show apps"]);
    await userEvent.setup().click(within(strip).getByRole("button", { name: "Show apps" }));
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(false));
    await waitFor(() => expect(document.activeElement?.id).toBe("kaiju-rail-apps"));
  });

  it("opens on Files the first time", async () => {
    fake.preferences = { rail_collapsed: true };
    await withApps();
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    const strip = must(rail().querySelector<HTMLElement>("[class*='icons']"));
    await userEvent.setup().click(within(strip).getByRole("button", { name: "Show files" }));
    await waitFor(() => expect(filesEl().hidden).toBe(false));
  });
});

describe("review fixes (KOBE-448)", () => {
  it("a stored Apps view never flashes Files while the apps list loads", async () => {
    fake.teamApps = [APP];
    fake.preferences = { rail_tab: "apps" };
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const inner = fake.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), "http://kaiju.test").pathname === "/v1/team/apps") await held;
      return inner(input, init);
    });
    openApp(fake);
    await composer();
    await waitFor(() => expect(screen.getByText("Loading apps…")).toBeTruthy());
    expect(filesEl().hidden).toBe(true);
    release();
    await waitFor(() => expect(appsEl()?.hidden).toBe(false), WAIT);
    expect(screen.queryByText("Loading apps…")).toBeNull();
  });

  it("an apps list that can't be read leaves Files, without waiting", async () => {
    fake.preferences = { rail_tab: "apps" };
    fake.failNext.set("GET /v1/team/apps", new Response(null, { status: 500 }));
    openApp(fake);
    await composer();
    await waitFor(() => expect(filesEl().hidden).toBe(false));
    expect(appsEl()).toBeNull();
    expect(screen.queryByText("Loading apps…")).toBeNull();
  });

  it("the Files section is the one Files element: no region inside it", async () => {
    await withApps();
    const files = within(rail()).getByRole("region", { name: "Files" });
    expect(files.id).toBe("kaiju-rail-files");
    expect(within(files).queryByRole("region")).toBeNull();
  });
});
