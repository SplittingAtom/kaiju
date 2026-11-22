// @vitest-environment happy-dom
/** A workspace lost with its server (KOBE-739): the notice, the dialog and the confirm. */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../lib/api/client";
import type { RebuildApi, RebuildResult, RebuildStatus } from "../../lib/workspace/rebuild";
import { VolumeLostNotice } from "./volume-lost-notice";

const LOST: RebuildStatus = {
  volume: "lost",
  lastSyncedAt: "2026-11-21T10:15:00Z",
  rebuildable: true,
};

function fakeApi(status: RebuildStatus, confirm?: ApiResult<RebuildResult>) {
  const api = {
    status: vi.fn(async (): Promise<ApiResult<RebuildStatus>> => ({
      ok: true,
      status: 200,
      data: status,
    })),
    confirm: vi.fn(
      async (): Promise<ApiResult<RebuildResult>> =>
        confirm ?? {
          ok: true,
          status: 200,
          data: { status: "rebuilt", lastSyncedAt: status.lastSyncedAt },
        },
    ),
  } satisfies RebuildApi;
  return api;
}

afterEach(cleanup);

describe("VolumeLostNotice", () => {
  it("in the Files panel shows only when the server says the volume is lost", async () => {
    const present = fakeApi({ volume: "present", lastSyncedAt: null, rebuildable: false });
    const { unmount } = render(<VolumeLostNotice api={present} mode="check" />);
    await waitFor(() => expect(present.status).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Rebuild sandbox…" })).toBeNull();
    unmount();

    render(<VolumeLostNotice api={fakeApi(LOST)} mode="check" />);
    expect(await screen.findByText(/storage that held your sandbox is lost/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rebuild sandbox…" })).toBeTruthy();
  });

  it("shows the last sync time and what is lost, and rebuilds only on confirm", async () => {
    const api = fakeApi(LOST);
    render(<VolumeLostNotice api={api} mode="known" />);
    await userEvent.click(screen.getByRole("button", { name: "Rebuild sandbox…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Rebuild your sandbox from the last sync\?/);
    expect(await screen.findByText(/Last sync:/)).toBeTruthy();
    expect(dialog.textContent).toMatch(/every change made after the last sync/);
    expect(dialog.textContent).toMatch(/node_modules/);
    expect(dialog.textContent).toMatch(/empty folders/);
    expect(dialog.textContent).toMatch(/If that server comes back later/);
    expect(api.confirm).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Rebuild sandbox" }));
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(
      await within(dialog).findByText(/being rebuilt from the last sync of My files\./),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText(/Send a message to start it/)).toBeTruthy();
  });

  it("offers no rebuild when the volume turns out reachable, and shows a refusal", async () => {
    const api = fakeApi({ volume: "present", lastSyncedAt: null, rebuildable: false });
    render(<VolumeLostNotice api={api} mode="known" />);
    await userEvent.click(screen.getByRole("button", { name: "Rebuild sandbox…" }));
    expect(await screen.findByText(/isn't lost, so there is nothing to rebuild/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rebuild sandbox" })).toBeNull();
  });

  it("shows the server's message when the confirm is refused", async () => {
    const api = fakeApi(LOST, {
      ok: false,
      error: {
        status: 409,
        code: "volume_reachable",
        message: "This workspace's storage isn't lost.",
      },
    });
    render(<VolumeLostNotice api={api} mode="known" />);
    await userEvent.click(screen.getByRole("button", { name: "Rebuild sandbox…" }));
    await userEvent.click(await screen.findByRole("button", { name: "Rebuild sandbox" }));
    expect(await screen.findByText("This workspace's storage isn't lost.")).toBeTruthy();
  });

  it("explains a server that is down but not for long enough, and offers no rebuild yet", async () => {
    const api = fakeApi({
      volume: "unreachable",
      lastSyncedAt: null,
      rebuildable: false,
      downSince: "2026-11-21T10:00:00Z",
      offerAt: "2026-11-21T10:30:00Z",
    });
    render(<VolumeLostNotice api={api} mode="known" />);
    await userEvent.click(screen.getByRole("button", { name: "Rebuild sandbox…" }));
    expect(await screen.findByText(/isn't answering/)).toBeTruthy();
    expect(screen.getByText(/may come back with the files/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rebuild sandbox" })).toBeNull();
  });

  it("says when the workspace never synced", async () => {
    render(<VolumeLostNotice api={fakeApi({ ...LOST, lastSyncedAt: null })} mode="known" />);
    await userEvent.click(screen.getByRole("button", { name: "Rebuild sandbox…" }));
    expect((await screen.findByText(/Last sync:/)).textContent).toMatch(/never/);
  });
});
