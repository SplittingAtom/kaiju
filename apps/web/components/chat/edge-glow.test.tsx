// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KaijuEventPayload } from "@kaiju/protocol";
import { FakeKaiju } from "../../lib/chat/testing/fake-kaiju";
import { must } from "../../lib/testing/must";
import { composer, openApp, streaming } from "./testing";

/**
 * KOBE-840 ac-3: the chat window's edge glows gold while the run waits for the member (a pending
 * approval, an interrupted run) and red after a failed run, until the next message or the notice
 * is closed; the words on screen stay. happy-dom has no cascade: this pins the thread root's
 * `data-kaiju-edge-glow`; app/edge-glow.test.ts pins the CSS and tokens.
 */
let fake: FakeKaiju;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKaiju();
  vi.stubGlobal("fetch", fake.fetch);
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const glow = () =>
  document.querySelector("[data-kaiju-thread-root]")?.getAttribute("data-kaiju-edge-glow") ?? null;

function asked(): KaijuEventPayload<"approval.requested"> {
  return {
    approval_id: "00000000-0000-4000-8000-000900000840",
    tool_call_id: "tc1",
    tool: "bash",
    input: { command: "rm -rf build" },
    risk: "write",
    reasons: [{ code: "risk_write", stage: "risk_class", message: "Changes files." }],
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

async function running(title = "Work") {
  const t = fake.addThread(title);
  openApp(fake, t);
  const user = userEvent.setup();
  await user.type(await composer(), "go{Enter}");
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const runId = must(fake.activeRun(t)).run_id;
  await streaming(fake, runId);
  return { t, runId, user };
}

describe("the chat window's edge glow (KOBE-840)", { timeout: 20_000 }, () => {
  it("none while the run simply works", async () => {
    await running();
    expect(glow()).toBeNull();
  });

  it("gold while an approval waits, with its words; gone once the member decided", async () => {
    const { runId, user } = await running();
    fake.agent.toolCall(runId, "tc1", "bash", { command: "rm -rf build" }, "m1");
    fake.requestApproval(runId, asked());
    await waitFor(() => expect(glow()).toBe("waiting"));
    const footer = must(document.querySelector<HTMLElement>("[data-kaiju-composer]"));
    expect(within(footer).getByText("Waiting for your approval")).toBeTruthy();
    const card = await screen.findByRole("group", { name: /Approval needed/ });
    await user.click(within(card).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(glow()).toBeNull());
  });

  it("gold while an interrupted run waits for Retry or Continue, with the Interrupted badge", async () => {
    const { runId } = await running();
    fake.agent.loseSandbox(runId);
    await waitFor(() => expect(glow()).toBe("waiting"));
    expect(document.querySelector("header [data-status-badge]")?.textContent).toBe("Interrupted");
  });

  it("red after a failed run, with the notice; gone once the notice is closed", async () => {
    const { runId, user } = await running();
    fake.agent.fail(runId, "start_failed", "No sandbox.");
    expect(await screen.findByText(/The run failed: No sandbox./)).toBeTruthy();
    await waitFor(() => expect(glow()).toBe("error"));
    await user.click(screen.getByRole("button", { name: "Close notice about the failed run" }));
    await waitFor(() => expect(glow()).toBeNull());
  });

  it("red after a failed run until the next message is sent", async () => {
    const { t, runId, user } = await running();
    fake.agent.fail(runId, "start_failed", "No sandbox.");
    await waitFor(() => expect(glow()).toBe("error"));
    await user.type(await composer(), "again{Enter}");
    await waitFor(() => expect(glow()).toBeNull());
    await waitFor(() => expect(fake.activeRun(t)?.run_id).not.toBe(runId));
    expect(glow()).toBeNull();
  });
});
