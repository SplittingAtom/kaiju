// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestReload,
  resetReloadRequest,
  stashDraftForReload,
  takeReloadDraft,
} from "../../lib/build/reload-draft";
import { command } from "../../lib/shell/commands";
import { IconActionProvider } from "./icon-action";
import { PROFILE_LINKS, ProfileMenu } from "./profile-menu";

const signOut = vi.fn(async () => ({ data: {}, error: null }));
vi.mock("../../lib/auth-client", () => ({ authClient: { signOut: () => signOut() } }));

afterEach(() => {
  cleanup();
  resetReloadRequest();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

/** KOBE-487: sign-out drops a composer draft kept for the new-build Reload. */
describe("ProfileMenu sign-out", () => {
  it("forgets the drafts kept for a reload", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    requestReload();
    stashDraftForReload("t1", "private draft");
    render(
      <IconActionProvider>
        <ProfileMenu />
      </IconActionProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/sign-in"));
    expect(takeReloadDraft("t1")).toBeUndefined();
  });
});

function renderMenu() {
  return render(
    <IconActionProvider>
      <ProfileMenu />
    </IconActionProvider>,
  );
}

/** KOBE-843: every item has an icon; My memory and My schedules moved here from the bar. */
describe("ProfileMenu items", () => {
  it("gives every item one decorative icon, the same size, before its name", () => {
    const { container } = renderMenu();
    const items = [...container.querySelectorAll("ul > li")];
    expect(items.length).toBe(PROFILE_LINKS.length + 1);
    for (const li of items) {
      const control = li.querySelector("a, button");
      const name = control?.textContent ?? "";
      const icons = control?.querySelectorAll("svg") ?? [];
      expect(icons.length, name).toBe(1);
      const icon = icons[0];
      expect(icon?.getAttribute("aria-hidden"), name).toBe("true");
      expect(icon?.hasAttribute("data-menu-icon"), name).toBe(true);
      expect(icon?.getAttribute("class"), name).toContain("size-4");
      expect(control?.firstElementChild, name).toBe(icon);
    }
  });

  it("keeps the icon out of each item's accessible name", () => {
    renderMenu();
    for (const link of PROFILE_LINKS) {
      expect(screen.getByRole("link", { name: link.name }).getAttribute("href")).toBe(link.href);
    }
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("lists My memory and My schedules with the icons they had in the bar, routes unchanged", () => {
    for (const id of ["my-memory", "my-schedules"] as const) {
      const c = command(id);
      const item = PROFILE_LINKS.find((l) => l.name === c.name);
      expect(item?.icon, id).toBe(c.icon);
      expect(item?.href, id).toBe(c.href);
    }
    expect(command("my-memory").href).toBe("/me/memory");
    expect(command("my-schedules").href).toBe("/me/schedules");
  });
});
