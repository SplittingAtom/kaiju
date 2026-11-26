// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextOf, section } from "../../lib/chat/testing/context-fixtures";
import { FakeKaiju } from "../../lib/chat/testing/fake-kaiju";
import { must } from "../../lib/testing/must";
import { openApp } from "../chat/testing";

/**
 * KOBE-846: the Context panel's three columns: the text, the gauge as a full-height vertical bar
 * dividing it from a right rail that holds the category totals then the conversation stats; free
 * space is the gauge's bottom segment; at phone width they stack (gauge, totals, stats, text).
 * happy-dom has no layout, so the DOM structure is checked here and the layout in the CSS.
 */
// Through a function: Vite rewrites a literal `new URL("./x.css", import.meta.url)` into an asset URL.
const css = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const CSS = css("./context-viewer.module.css");

/** Every declaration block whose selector list names `selector`, media blocks included. */
function rules(selector: string, source = CSS): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selectors = "", body = ""] of source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(re)) {
    if (selectors.split(",").some((s) => s.trim() === selector))
      out.push(body.replace(/\s+/g, " "));
  }
  return out;
}

/** The narrow layout's media block. */
const NARROW = /@media \(width < 720px\) \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? "";

let fake: FakeKaiju;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKaiju();
  fake.teamModels.push({
    alias: "kimi",
    label: "Kimi K2.7 Code",
    enabled: true,
    is_default: true,
    context_window: 200_000,
  });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SECTIONS = [
  section("system_prompt", 4_000, "You are Pi.", "preamble"),
  section("tool_definitions", 2_000, '{"name":"read"}', "read"),
  section("user_message", 1_000, "Hello there"),
  section("assistant_message", 2_000, "Hello back"),
];

async function openPanel() {
  const t = fake.addThread("Report");
  fake.threadLatestCall.set(t, {
    run_id: "00000000-0000-4000-8000-0000000000aa",
    at: "2026-10-21T10:00:00.000Z",
    model: "ollama/kimi",
    input_tokens: 9_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  fake.threadContext.set(t, [
    { status: 200, body: contextOf(SECTIONS, { thread_id: t, context_window: 20_000 }) },
  ]);
  openApp(fake, t);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("meter", { name: "Context used" }));
  const dialog = await screen.findByRole("dialog", { name: "Context" });
  await within(dialog).findByRole("list", { name: "Context by kind" });
  return { user, dialog };
}

describe("the Context panel's layout", () => {
  it("has three columns: the text, the gauge, then a rail with the totals and the stats", async () => {
    const { dialog } = await openPanel();
    const columns = must(dialog.querySelector("[data-context-columns]"));
    const [text, gauge, rail] = [...columns.children];
    expect(text?.contains(within(dialog).getByRole("region", { name: "Context text" }))).toBe(true);
    expect(gauge?.hasAttribute("data-context-bar")).toBe(true);
    expect(rail?.hasAttribute("data-context-rail")).toBe(true);
    // The rail scrolls on its own and the keyboard can reach it.
    expect(rail?.getAttribute("role")).toBe("region");
    expect(rail?.getAttribute("aria-label")).toBe("Totals and stats");
    expect(rail?.getAttribute("tabindex")).toBe("0");
    // Totals first, then the stats.
    const [totals, stats] = [...must(rail).children];
    expect(totals?.getAttribute("aria-label")).toBe("Context by kind");
    await waitFor(() => expect(stats?.hasAttribute("data-context-stats")).toBe(true));
  });

  it("keeps the gauge an image with a text equivalent; the totals carry the figures", async () => {
    const { dialog } = await openPanel();
    const gauge = within(dialog).getByRole("img", { name: /^Context window: / });
    expect(gauge.getAttribute("aria-label")).toBe(
      "Context window: 9k of 20k tokens used (45%), 11k free. Each kind is listed in Context by kind.",
    );
    expect(must(gauge.firstElementChild).getAttribute("aria-hidden")).toBe("true");
  });

  it("stacks the used kinds in the totals' order, free space the bottom segment", async () => {
    const { dialog } = await openPanel();
    const bar = must(dialog.querySelector("[data-context-bar] > div"));
    const order = [...bar.children].map(
      (el) =>
        el.getAttribute("data-context-segment") ??
        (el.hasAttribute("data-context-segment-free") ? "free" : "?"),
    );
    const legend = within(dialog).getByRole("list", { name: "Context by kind" });
    const listed = [...legend.querySelectorAll("[data-context-legend]")]
      .map((el) => el.getAttribute("data-context-legend"))
      .filter((k) => k !== "memory"); // 0 tokens: listed, no segment
    expect(order).toEqual([...listed, "free"]);
    // Heights are the shares of the window.
    const shareOf = (kind: string) =>
      (
        must(bar.querySelector(`[data-context-segment='${kind}']`)) as HTMLElement
      ).style.getPropertyValue("--share");
    expect(shareOf("system_prompt")).toBe("20%");
    expect(shareOf("user_message")).toBe("5%");
    expect(must(bar.lastElementChild).getAttribute("title")).toBe("Free: 11k tokens");
  });

  it("highlights the filtered kind's vertical segment and clears with the row again", async () => {
    const { user, dialog } = await openPanel();
    const legend = within(dialog).getByRole("list", { name: "Context by kind" });
    const row = within(legend).getByRole("button", { name: /^User prompts: / });
    await user.click(row);
    const gauge = must(dialog.querySelector("[data-context-bar]"));
    expect(gauge.hasAttribute("data-filtered")).toBe(true);
    expect(
      gauge.querySelector("[data-context-segment='user_message']")?.hasAttribute("data-selected"),
    ).toBe(true);
    row.focus();
    await user.keyboard("{Enter}");
    expect(gauge.hasAttribute("data-filtered")).toBe(false);
  });
});

describe("the Context panel's CSS", () => {
  it("lays out three columns, the gauge the panel's full height", () => {
    expect(rules(".columns")[0]).toContain("display: grid;");
    expect(rules(".columns")[0]).toContain(
      "grid-template-columns: minmax(0, 2fr) 1.75rem minmax(16rem, 1fr);",
    );
    expect(rules(".columns")[0]).toContain("grid-template-rows: minmax(0, 1fr);");
    expect(rules(".bar")[0]).toContain("flex: 1 1 auto;");
  });

  it("stacks the bar top to bottom, so free space (last) is the bottom segment", () => {
    expect(rules(".bar")[0]).toContain("flex-direction: column;");
    expect(rules(".bar")[0]).not.toContain("column-reverse");
    expect(rules(".segment")[0]).toContain("flex: 0 1 var(--share);");
    expect(rules(".free")[0]).toContain("flex: 1 1 auto;");
  });

  it("scrolls the rail on its own", () => {
    expect(rules(".rail")[0]).toContain("overflow-y: auto;");
    expect(rules(".rail")[0]).toContain("min-height: 0;");
    expect(rules(".stats")[0]).not.toContain("overflow");
  });

  it("stacks gauge (horizontal), totals and stats, then the text, when narrow", () => {
    expect(NARROW).not.toBe("");
    expect(rules(".columns", NARROW)[0]).toContain("flex-direction: column;");
    expect(rules(".columns .gauge", NARROW)[0]).toContain("order: -2;");
    expect(rules(".columns .rail", NARROW)[0]).toContain("order: -1;");
    expect(rules(".bar", NARROW)[0]).toContain("flex-direction: row;");
  });

  it("uses theme tokens for colours", () => {
    for (const selector of [".bar", ".segment", ".rail:focus-visible"]) {
      for (const body of rules(selector)) expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    }
  });
});
