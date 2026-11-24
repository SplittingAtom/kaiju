// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildInfoFrom } from "../../lib/build/build-info";
import { pageBySlug } from "../../lib/docs/guide";
import { BuildLine } from "./build-line";
import { GuideView } from "./guide-view";

/** KOBE-837: the running build beside the guide's title. */
afterEach(cleanup);

const BUILT = {
  KAIJU_BUILD_SHA: "1e6fff80abcd0123456789abcdef0123456789ab",
  KAIJU_BUILD_DATE: "2026-11-24T14:03:09Z",
};

describe("BuildLine", () => {
  it("shows the build number and the UTC build date as text", () => {
    const { container } = render(<BuildLine build={buildInfoFrom(BUILT)} />);
    const line = container.querySelector("[data-kaiju-build]");
    expect(line?.textContent).toBe("Build 1e6fff80abcd · 2026-11-24 14:03 UTC");
    expect(line?.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-24T14:03:09.000Z");
    expect(line?.className).toContain("text-muted-foreground");
  });

  it("puts the release version first when one is set", () => {
    const { container } = render(
      <BuildLine build={buildInfoFrom({ ...BUILT, KAIJU_BUILD_VERSION: "1.4.0" })} />,
    );
    expect(container.querySelector("[data-kaiju-build]")?.textContent).toBe(
      "Version 1.4.0 · Build 1e6fff80abcd · 2026-11-24 14:03 UTC",
    );
  });

  it("shows Development build when a value is missing", () => {
    render(<BuildLine build={buildInfoFrom({ KAIJU_BUILD_SHA: BUILT.KAIJU_BUILD_SHA })} />);
    expect(screen.getByText("Development build")).toBeTruthy();
  });

  it("rejects a garbage value instead of rendering it", () => {
    const { container } = render(
      <BuildLine
        build={buildInfoFrom({ KAIJU_BUILD_SHA: "<b>pwned</b>", KAIJU_BUILD_DATE: "soon" })}
      />,
    );
    expect(container.textContent).toBe("Development build");
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("GuideView with the build", () => {
  it("shows it beside the guide title on the home", () => {
    render(<GuideView page={null} appName="Kaiju" build={buildInfoFrom(BUILT)} />);
    const title = screen.getByRole("heading", { level: 1, name: "Kaiju guide" });
    expect(title.parentElement?.textContent).toContain("Build 1e6fff80abcd · 2026-11-24 14:03 UTC");
  });

  it("shows it on a guide page and reads Development build without one", () => {
    const page = pageBySlug("getting-started");
    expect(page).not.toBeNull();
    render(<GuideView page={page} appName="Kaiju" />);
    expect(screen.getByText("Development build")).toBeTruthy();
  });
});
