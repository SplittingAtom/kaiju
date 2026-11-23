// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { onShowFilesRequest, requestShowFiles } from "./files-request";

describe("show the Files panel from outside the workspace (KOBE-819)", () => {
  it("delivers each request until unsubscribed", () => {
    const show = vi.fn();
    const off = onShowFilesRequest(show);
    requestShowFiles({ projectId: "p1" });
    expect(show).toHaveBeenCalledWith({ projectId: "p1" });
    off();
    requestShowFiles({ projectId: "p2" });
    expect(show).toHaveBeenCalledTimes(1);
  });
});
