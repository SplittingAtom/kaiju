// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

/** KOBE-654: a tooltip opened by keyboard focus survives the scroll that focus caused. */
afterEach(cleanup);

function Fixture() {
  return (
    <TooltipProvider delayDuration={0}>
      <div data-testid="scroller">
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button">badge</button>
          </TooltipTrigger>
          <TooltipContent>tip text</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

const shown = () => document.querySelector('[data-slot="tooltip-content"]');
const open = async () => {
  render(<Fixture />);
  const badge = screen.getByRole("button", { name: "badge" });
  act(() => badge.focus());
  await waitFor(() => expect(shown()).not.toBeNull());
  return badge;
};

describe("Tooltip focus", () => {
  it("opens on keyboard focus and closes on Escape", async () => {
    const badge = await open();
    fireEvent.keyDown(badge, { key: "Escape" });
    await waitFor(() => expect(shown()).toBeNull());
  });

  it("stays open when the scroll that focus caused reaches an ancestor", async () => {
    await open();
    fireEvent.scroll(screen.getByTestId("scroller"));
    await new Promise((r) => setTimeout(r, 50));
    expect(shown()).not.toBeNull();
  });

  it("closes on Escape even right after a focus-caused scroll", async () => {
    const badge = await open();
    fireEvent.scroll(screen.getByTestId("scroller"));
    fireEvent.keyDown(badge, { key: "Escape" });
    await waitFor(() => expect(shown()).toBeNull());
  });

  it("closes when focus leaves the trigger", async () => {
    const badge = await open();
    act(() => badge.blur());
    await waitFor(() => expect(shown()).toBeNull());
  });
});
