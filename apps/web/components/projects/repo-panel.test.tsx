// @vitest-environment happy-dom
/** Repo details… follows a refresh until the mirror settles (KOBE-768 review M1). */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../lib/api/client";
import type { RepoApi, RepoView } from "../../lib/projects/repo-api";
import { RepoPanel } from "./repo-panel";

afterEach(cleanup);

const view = (refreshing: boolean): RepoView => ({
  projectId: "p1",
  repositoryId: "r1",
  connectionId: "c1",
  provider: "github",
  baseUrl: "https://github.com",
  fullName: "acme/q4",
  webUrl: "https://github.com/acme/q4",
  defaultBranch: "main",
  hostState: "active",
  readOnly: false,
  readOnlyReason: null,
  canManage: false,
  mirror: {
    headSha: null,
    refreshedAt: "2026-11-23T10:00:00Z",
    attemptedAt: null,
    refreshing,
    nextAttemptAt: null,
    failures: 0,
    error: null,
    tooLarge: false,
  },
  commits: [],
});

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, status: 200, data });

describe("Refresh in Repo details", () => {
  it("reads the mirror again until it settles, then Refresh works again", async () => {
    const api = {
      refresh: vi.fn(async () => ok(view(true))),
      repo: vi
        .fn<RepoApi["repo"]>()
        .mockResolvedValueOnce(ok(view(true)))
        .mockResolvedValue(ok(view(false))),
      relink: vi.fn(),
      detach: vi.fn(),
    };
    const onChanged = vi.fn();
    render(
      <RepoPanel
        project={{ id: "p1", name: "Q4" }}
        info={{ view: view(false), status: null }}
        api={api}
        git={null}
        onChanged={onChanged}
        onDetached={vi.fn()}
        onClose={vi.fn()}
        refreshReadMs={10}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Q4: Repo" });
    const refresh = within(dialog).getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    await userEvent.setup().click(refresh);
    expect(await within(dialog).findByText("Refreshing from the host…")).toBeTruthy();
    expect(refresh.disabled).toBe(true);
    expect(await within(dialog).findByText(/^Last refreshed /)).toBeTruthy();
    expect(refresh.disabled).toBe(false);
    expect(api.repo).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
