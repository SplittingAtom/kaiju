// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitApproval, KobeEventPayload } from "@kobe/protocol";
import { ApprovalCard } from "./approval-card";
import { GIT_BODY_PREVIEW, GitChange } from "./git-approval";

/**
 * The git host write's approval card (KOBE-762, spec workspace-git G9, G10, G13): host,
 * organization and repository named, the full posted text as plain text with "Show all", a new
 * repository's visibility, nothing from the input rendered as HTML.
 */
afterEach(() => cleanup());

const PR: GitApproval = {
  action: "open_pull_request",
  provider: "forgejo",
  host: "git.example.test",
  organization: "acme",
  connection_name: "Acme on Forgejo",
  repository: "docs",
  title: "<img src=x onerror=alert(1)> Fix",
  body: "Fixes it.\n\n---\nOpened by Ana Lee via Kobe, from conversation https://kobe.test/?thread=t",
  head: "feature",
  base: "main",
  draft: false,
};

describe("GitChange", () => {
  it("names the action, host, organization, connection and repository", () => {
    render(<GitChange git={PR} />);
    const header = screen.getByText(/Open a pull request/).closest("p");
    expect(header?.textContent).toBe(
      "Open a pull request on Forgejo git.example.test, organization acme (connection Acme on Forgejo)",
    );
    const table = screen.getByRole("table", { name: "What will be created" });
    expect(within(table).getByRole("row", { name: /Repository docs/ })).toBeTruthy();
    expect(within(table).getByRole("row", { name: /From branch feature/ })).toBeTruthy();
    expect(within(table).getByRole("row", { name: /Into branch main/ })).toBeTruthy();
  });

  it("shows titles and bodies as plain text, never HTML", () => {
    const { container } = render(<GitChange git={PR} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("row", { name: /Title/ }).textContent).toContain("<img src=x");
    expect(screen.getByLabelText("Text that will be posted").textContent).toBe(PR.body);
  });

  it("cuts a long body and shows all of it on request", async () => {
    const body = `${"a".repeat(GIT_BODY_PREVIEW)}TAIL`;
    render(<GitChange git={{ ...PR, body }} />);
    const pre = screen.getByLabelText("Text that will be posted");
    expect(pre.textContent).not.toContain("TAIL");
    const more = screen.getByRole("button", { name: /Show all/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(more);
    expect(pre.textContent).toContain("TAIL");
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("makes hidden characters visible", () => {
    render(<GitChange git={{ ...PR, body: "safe‮evil" }} />);
    expect(screen.getByLabelText("Text that will be posted").textContent).toBe("safe\\u202eevil");
  });

  it("shows a new repository's visibility", () => {
    render(
      <GitChange
        git={{
          action: "create_repository",
          provider: "github",
          host: "github.com",
          organization: "acme",
          connection_name: "Acme",
          repository: "kobe-new",
          visibility: "private",
        }}
      />,
    );
    expect(screen.getByRole("row", { name: /New repository kobe-new/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /Visibility Private/ })).toBeTruthy();
    expect(screen.queryByLabelText("Text that will be posted")).toBeNull();
  });

  it("names the issue or pull request a comment goes on", () => {
    render(
      <GitChange
        git={{ ...PR, action: "comment", title: undefined, number: 7, on: "pull_request" } as never}
      />,
    );
    expect(screen.getByRole("row", { name: /Pull request #7/ })).toBeTruthy();
  });
});

describe("in the approval card", () => {
  it("shows the git header above the exact input", () => {
    const requested: KobeEventPayload<"approval.requested"> = {
      approval_id: "00000000-0000-4000-8000-000900000001",
      tool_call_id: "tc1",
      tool: "mcp__kobe__git_open_pull_request",
      input: { connection: "c", repository: "docs" },
      risk: "write",
      reasons: [{ code: "risk_write", stage: "risk_class", message: "changes data" }],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      git: PR,
    };
    const api = { decideApproval: vi.fn(), getApproval: vi.fn() };
    render(<ApprovalCard requested={requested} resolved={undefined} api={api as never} />);
    const card = screen.getByRole("group", { name: /Approval needed/ });
    expect(within(card).getByText(/Open a pull request/)).toBeTruthy();
    expect(within(card).getByLabelText("Input to approve").textContent).toContain('"repository"');
  });
});
