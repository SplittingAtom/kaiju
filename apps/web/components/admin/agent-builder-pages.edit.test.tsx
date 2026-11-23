// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { AgentBuilderPage } from "./team/agent-builder/agent-builder-page";
import { TEAM, answerConfirm, renderTeam, stubApi } from "./testing";
import {
  AGENT,
  VERSIONS,
  READ,
  assign,
  useAgentBuilderStubs,
} from "./agent-builder-pages.test-helpers";

useAgentBuilderStubs();

describe("Agent builder: create", () => {
  it("refuses an invalid definition with field errors and sends nothing", async () => {
    const calls = stubApi(READ);
    renderTeam(<AgentBuilderPage />);
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    // The summary and the field's own error are both announced (KOBE-295: console Field errors).
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual([
      expect.stringMatching(/fix 1 problem/i),
      expect.stringMatching(/empty/),
    ]);
    const name = screen.getByLabelText("Name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const describedBy = must(name.getAttribute("aria-describedby"));
    expect(document.getElementById(describedBy)?.textContent).toMatch(/empty/);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("creates a team agent from the form and opens it", async () => {
    const calls = stubApi({ "POST /v1/agents": [201, { agent: { ...AGENT, id: "a-9" } }] });
    renderTeam(<AgentBuilderPage />);
    await userEvent.type(screen.getByLabelText("Name"), "Triage");
    await userEvent.type(screen.getByLabelText("System prompt"), "Be helpful.");
    await userEvent.click(screen.getByRole("tab", { name: "Behaviour" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Skill name" }), "sql");
    await userEvent.click(screen.getByRole("button", { name: "Add skill" }));
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/admin/team/agents/a-9"));
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      scope: "team",
      frontmatter: { name: "Triage", skills: ["sql"] },
      prompt: "Be helpful.",
    });
    expect(post.headers.get("x-kobe-team")).toBe(TEAM.id);
  });
});

describe("Agent builder: edit and publish", () => {
  it("saves the draft against the revision it loaded", async () => {
    const calls = stubApi({
      ...READ,
      "PUT /v1/agents/a-1": [200, { agent: { ...AGENT, revision: 4, prompt: "Be brief." } }],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const prompt = await screen.findByLabelText("System prompt");
    expect((prompt as HTMLTextAreaElement).value).toBe("Be helpful.");
    await userEvent.clear(prompt);
    await userEvent.type(prompt, "Be brief.");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(put.headers.get("if-match")).toBe('"3"');
    expect(JSON.parse(String(put.body)).prompt).toBe("Be brief.");
    expect(JSON.parse(String(put.body)).frontmatter).toEqual(AGENT.frontmatter);
  });

  it("publishes through a dialog that shows what goes out, warnings included", async () => {
    const calls = stubApi({
      ...READ,
      "PUT /v1/agents/a-1": [
        200,
        {
          agent: { ...AGENT, revision: 4, frontmatter: { name: "Triage", approval_mode: "auto" } },
        },
      ],
      "POST /v1/agents/a-1/publish": [
        201,
        {
          agent: { ...AGENT, revision: 4, currentVersion: 7 },
          version: { ...VERSIONS.versions[0], version: 7 },
        },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.selectOptions(await screen.findByLabelText("Approval mode"), "auto");
    // Unsaved edits can't be published: the dialog saves nothing on its own.
    expect((screen.getByRole("button", { name: "Publish…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    await userEvent.click(screen.getByRole("button", { name: "Publish…" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish Triage as v3" });
    expect(within(dialog).getByText(/auto runs only allow-listed tools/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish v3" }));
    // The notice names the version the server assigned, not currentVersion + 1.
    await screen.findByText("Published v7.");
    expect(screen.queryByRole("dialog")).toBeNull();
    const publish = must(calls.find((c) => c.url.endsWith("/publish")));
    expect(publish.headers.get("if-match")).toBe('"4"');
  });

  it("says which named team skills a publish left out (KOBE-318)", async () => {
    stubApi({
      ...READ,
      "POST /v1/agents/a-1/publish": [
        201,
        {
          agent: { ...AGENT, currentVersion: 7 },
          version: { ...VERSIONS.versions[0], version: 7 },
          skillsLeftOut: [{ name: "house-style", reason: "blocklisted" }],
        },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Publish…" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^Publish v/ }));
    await screen.findByText(
      "Published v7. house-style is left out of v7: every version is blocklisted.",
    );
  });

  it("cancels the dialog with Escape and shows a publish conflict in it", async () => {
    stubApi({
      ...READ,
      "POST /v1/agents/a-1/publish": [
        412,
        { code: "revision_mismatch", message: "Someone else changed this agent." },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Publish…" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Publish…" }));
    await userEvent.click(screen.getByRole("button", { name: "Publish v3" }));
    expect((await within(screen.getByRole("dialog")).findByRole("alert")).textContent).toMatch(
      "Someone else changed this agent.",
    );
  });

  it("gives the Publish button its focus back after Cancel and after Escape (review M1)", async () => {
    stubApi(READ);
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const publish = await screen.findByRole("button", { name: "Publish…" });
    await userEvent.click(publish);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(publish));

    await userEvent.click(publish);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(publish));
  });

  it("stays open on an outside press, and can't be closed while publishing (review S1)", async () => {
    let answer: (value: Response) => void = () => {};
    stubApi(READ);
    const api = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url === "/v1/agents/a-1/publish"
          ? new Promise<Response>((resolve) => {
              answer = resolve;
            })
          : api(url, init),
      ),
    );
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Publish…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("dialog")).toBe(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish v3" }));
    // In flight: Escape, Cancel and outside presses leave it open.
    await userEvent.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    answer(
      new Response(
        JSON.stringify({ code: "revision_mismatch", message: "Someone else changed this agent." }),
        { status: 412 },
      ),
    );
    // The refusal shows in the dialog that is still open.
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      "Someone else changed this agent.",
    );
  });

  it("lets an editor without the publish right save, but offers no Publish or Restore", async () => {
    stubApi({
      ...READ,
      "GET /v1/agents/a-1": [200, { agent: { ...AGENT, canPublish: false } }],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await screen.findByRole("button", { name: "Save draft" });
    expect(screen.queryByRole("button", { name: "Publish…" })).toBeNull();
    await screen.findByRole("region", { name: "Version history" });
    await screen.findAllByRole("row");
    expect(screen.queryByRole("button", { name: /Restore version/ })).toBeNull();
  });

  it("is read-only when the caller can't edit", async () => {
    stubApi({ ...READ, "GET /v1/agents/a-1": [200, { agent: { ...AGENT, canEdit: false } }] });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    expect((await screen.findByLabelText("Name")).hasAttribute("readonly")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("views someone else's rostered agent read-only at its version in effect (KOBE-571, AR14)", async () => {
    const calls = stubApi({
      ...READ,
      "GET /v1/agents/a-1": [
        200,
        {
          agent: {
            ...AGENT,
            canEdit: false,
            canPublish: false,
            canExport: true,
            versionInEffect: 2,
          },
        },
      ],
    });
    renderTeam(<AgentBuilderPage scope="personal" agentId="a-1" />);
    expect(await screen.findByText(/You're viewing v2, the version this roster runs/)).toBeTruthy();
    expect((await screen.findByLabelText("Name")).hasAttribute("readonly")).toBe(true);
    await screen.findByRole("region", { name: "Version history" });
    // The owner's evals, ratings, shared cases and exports are not read.
    expect(screen.queryByRole("button", { name: /Export .*Orbit/ })).toBeNull();
    expect(calls.some((c) => /\/(evals|feedback|cases)/.test(c.url))).toBe(false);
  });

  it("says a suspended agent can't start runs, and stays editable (KOBE-86)", async () => {
    stubApi({ ...READ, "GET /v1/agents/a-1": [200, { agent: { ...AGENT, status: "suspended" } }] });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    expect((await screen.findByText(/This agent is suspended/)).textContent).toMatch(
      /can't start new runs/,
    );
    expect((await screen.findByLabelText("Name")).hasAttribute("readonly")).toBe(false);
  });
});

describe("Agent builder: version history", () => {
  it("lists versions, marks the current one and restores an earlier one", async () => {
    const calls = stubApi({
      ...READ,
      "POST /v1/agents/a-1/rollback": [
        201,
        {
          agent: {
            ...AGENT,
            revision: 5,
            currentVersion: 3,
            prompt: "Old prompt.",
            frontmatter: { name: "Triage v1" },
          },
          version: { ...VERSIONS.versions[1], version: 3, republished_from: 1 },
        },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const history = await screen.findByRole("region", { name: "Version history" });
    const rows = await within(history).findAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2 versions
    expect(within(must(rows[1])).getByText("Current")).toBeTruthy();
    expect(within(history).queryByRole("button", { name: "Restore version 2" })).toBeNull();
    await userEvent.click(within(history).getByRole("button", { name: "Restore version 1" }));
    expect(calls.some((c) => c.url.endsWith("/rollback"))).toBe(false);
    await answerConfirm("Restore version 1 as the newest version?", "Restore version 1");
    await screen.findByText("Restored v1 as v3.");
    const post = must(calls.find((c) => c.url.endsWith("/rollback")));
    expect(JSON.parse(String(post.body))).toEqual({ version: 1 });
    expect((screen.getByLabelText("System prompt") as HTMLTextAreaElement).value).toBe(
      "Old prompt.",
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Triage v1");
  });

  it("labels a memory change from the stored rows and warns when a restore changes memory (KOBE-646)", async () => {
    // v3 republished v2 with memory off (a memory change); v2 is a restore of v1 (same memory).
    const three = {
      version: 3,
      published_by: "u-me",
      published_at: "2026-10-03T10:00:00Z",
      draft_revision: null,
      republished_from: 2,
      memory: "off",
    };
    const history = {
      current_version: 3,
      versions: [
        three,
        { ...VERSIONS.versions[0], republished_from: 1, draft_revision: null, memory: "all" },
        { ...VERSIONS.versions[1], memory: "all" },
      ],
      next_before: null,
    };
    stubApi({
      ...READ,
      "GET /v1/agents/a-1": [200, { agent: { ...AGENT, currentVersion: 3 } }],
      "GET /v1/agents/a-1/versions": [200, history],
      "GET /v1/agents/a-1/versions/3": [
        200,
        { version: { ...three, frontmatter: AGENT.frontmatter, prompt: AGENT.prompt } },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const region = await screen.findByRole("region", { name: "Version history" });
    expect(await within(region).findByText("Memory changed from v2")).toBeTruthy();
    expect(within(region).getByText("Restored from v1")).toBeTruthy();
    expect(within(region).getByText("Memory: Off")).toBeTruthy();
    await userEvent.click(within(region).getByRole("button", { name: "Restore version 1" }));
    const text = await answerConfirm("Restore version 1 as the newest version?", "Cancel");
    expect(text).toContain("Memory: Off → All memory.");
  });

  it("doesn't restore when the user declines the confirmation", async () => {
    const calls = stubApi(READ);
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const restore = await screen.findByRole("button", { name: "Restore version 1" });
    await userEvent.click(restore);
    await answerConfirm("Restore version 1 as the newest version?", "Cancel");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(document.activeElement).toBe(restore);
  });

  it("loads older versions on request", async () => {
    const calls = stubApi({
      ...READ,
      "GET /v1/agents/a-1/versions": [
        200,
        { ...VERSIONS, versions: [VERSIONS.versions[0]], next_before: 2 },
      ],
      "GET /v1/agents/a-1/versions?before=2": [
        200,
        { current_version: 2, versions: [VERSIONS.versions[1]], next_before: null },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Load older versions" }));
    await screen.findByRole("button", { name: "Restore version 1" });
    expect(calls.some((c) => c.url.endsWith("before=2"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Load older versions" })).toBeNull();
  });
});

describe("Agent builder: model picker", () => {
  it("offers the team's enabled models and the team default, and saves the choice", async () => {
    const calls = stubApi({
      ...READ,
      "POST /v1/agents": [201, { agent: { ...AGENT, id: "a-9" } }],
    });
    renderTeam(<AgentBuilderPage />);
    const select = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect([...select.options].map((o) => o.text)).toEqual([
      "None (use team default)",
      "fast",
      "Smart",
    ]);
    await userEvent.selectOptions(select, "smart");
    await userEvent.type(screen.getByLabelText("Name"), "Triage");
    await userEvent.type(screen.getByLabelText("System prompt"), "Hi");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body)).frontmatter.model).toBe("smart");
  });

  it("keeps a stored model that is no longer enabled", async () => {
    stubApi({
      ...READ,
      "GET /v1/agents/a-1": [
        200,
        { agent: { ...AGENT, frontmatter: { name: "Triage", model: "local" } } },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const select = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("local"));
    expect(select.selectedOptions[0]?.text).toBe("local (not enabled)");
  });
});
