// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { memoryItemHref, memoryTabOf } from "../../lib/memory/tabs";
import type { ReactElement } from "react";
import { IconActionProvider } from "../shell/icon-action";
import { OpenInMemoryChip as Chip } from "./open-in-memory-chip";

const OpenInMemoryChip = (props: Parameters<typeof Chip>[0]): ReactElement => (
  <IconActionProvider>
    <Chip {...props} />
  </IconActionProvider>
);

/** KOBE-399: the "Open in Memory" chip under a `show_memory_item` call. */
const ID = "00000000-0000-4000-8000-00000000b001";

afterEach(cleanup);

describe("Open in Memory chip", () => {
  it("links to the item on the Memories tab once the call succeeded", () => {
    render(<OpenInMemoryChip args={{ id: ID }} done failed={false} />);
    const link = screen.getByRole("link", { name: "Open in Memory" });
    expect(link.getAttribute("href")).toBe(`/me/memory?item=${ID}`);
    expect(memoryTabOf(`?item=${ID}`)).toBe("memories");
    expect(memoryItemHref(ID, "team")).toBe(`/me/memory?item=${ID}&scope=team`);
  });

  it("shows nothing while running, after a failure, or for an id that is not one", () => {
    const { rerender } = render(<OpenInMemoryChip args={{ id: ID }} done={false} failed={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    rerender(<OpenInMemoryChip args={{ id: ID }} done failed />);
    expect(screen.queryByRole("link")).toBeNull();
    rerender(<OpenInMemoryChip args={{ id: "javascript:alert(1)" }} done failed={false} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
