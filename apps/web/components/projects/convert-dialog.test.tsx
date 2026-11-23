// @vitest-environment happy-dom
/**
 * The Convert to repo dialog (KOBE-768, ac-2; spec workspace-git G16, GQ12, GQ13): connection
 * choice with each connection's prefix, the history choice, the admin-only existing repository,
 * refusals in plain words with the files the server names, the conversion's progress and its end
 * states (completed, failed with Retry and Abandon, abandoned with the repository left on the host).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../lib/api/client";
import type { RepoApi, RepoConversion } from "../../lib/projects/repo-api";
import { ConvertDialog } from "./convert-dialog";
import type { GitConnections } from "./workspace-repos";

afterEach(cleanup);

const attempt = (over: Partial<RepoConversion> = {}): RepoConversion => ({
  id: "x1",
  projectId: "p1",
  status: "running",
  step: "create",
  connectionId: "c1",
  provider: "github",
  baseUrl: "https://github.com",
  organization: "acme",
  repositoryName: "kobe-q4",
  fullName: "acme/kobe-q4",
  visibility: "private",
  carryHistory: true,
  useExisting: false,
  defaultBranch: "main",
  repositoryCreated: false,
  commitsTotal: 3,
  commitsPushed: 0,
  headSha: null,
  error: null,
  attempts: 1,
  requestedBy: "u1",
  createdAt: "2026-11-23T10:00:00Z",
  updatedAt: "2026-11-23T10:00:00Z",
  finishedAt: null,
  ...over,
});

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, status: 200, data });

const member = (id: string, prefix: string, accessLevel = "read_write" as const) => ({
  id,
  provider: "github" as const,
  baseUrl: id === "c2" ? "https://git.example.com" : "https://github.com",
  organization: id === "c2" ? "ops" : "acme",
  displayName: id === "c2" ? "Ops Forgejo" : "Acme",
  accessLevel,
  status: "ok" as const,
  repoNamePrefix: prefix,
});

const git = (over: Partial<GitConnections> = {}): GitConnections => ({
  connections: [member("c1", "kobe-")],
  enabled: true,
  admin: false,
  ...over,
});

function api(over: Partial<RepoApi> = {}) {
  return {
    conversion: vi.fn<RepoApi["conversion"]>(async () => ok(null)),
    startConversion: vi.fn<RepoApi["startConversion"]>(async () => ok(attempt())),
    retryConversion: vi.fn<RepoApi["retryConversion"]>(async () => ok(attempt())),
    abandonConversion: vi.fn<RepoApi["abandonConversion"]>(async () =>
      ok({ conversion: attempt({ status: "abandoned" }), leftOnHost: null }),
    ),
    ...over,
  };
}

function mount(a: ReturnType<typeof api>, g: GitConnections | null = git()) {
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <ConvertDialog
      project={{ id: "p1", name: "Q4", slug: "q4" }}
      api={a}
      git={g}
      onChanged={onChanged}
      onClose={onClose}
      pollMs={10}
    />,
  );
  return {
    onChanged,
    onClose,
    dialog: screen.getByRole("dialog", { name: "Convert Q4 to a repo" }),
  };
}

describe("the form", () => {
  it("chooses among connections and follows each one's prefix", async () => {
    const a = api();
    const { dialog } = mount(a, git({ connections: [member("c1", "kobe-"), member("c2", "")] }));
    const user = userEvent.setup();
    const name = (await within(dialog).findByLabelText("Repository name")) as HTMLInputElement;
    expect(name.value).toBe("kobe-q4");
    await user.selectOptions(within(dialog).getByLabelText("Git connection"), "c2");
    expect(name.value).toBe("q4");
    expect(
      within(dialog).getByText(/^A private repository in ops on git\.example\.com:/),
    ).toBeTruthy();
    // A typed name is kept when the connection changes.
    await user.clear(name);
    await user.type(name, "budget");
    await user.selectOptions(within(dialog).getByLabelText("Git connection"), "c1");
    expect(name.value).toBe("budget");
  });

  it("checks the name before asking, and offers an existing repository to admins only", async () => {
    const a = api();
    const { dialog } = mount(a, git({ admin: true }));
    const user = userEvent.setup();
    const name = await within(dialog).findByLabelText("Repository name");
    await user.clear(name);
    await user.type(name, "has space");
    await user.click(within(dialog).getByRole("button", { name: "Convert" }));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/letters, digits/);
    expect(a.startConversion).not.toHaveBeenCalled();
    await user.clear(name);
    await user.type(name, "empty-one");
    await user.click(within(dialog).getByLabelText(/existing empty repository/));
    await user.click(within(dialog).getByRole("button", { name: "Convert" }));
    expect(a.startConversion).toHaveBeenCalledWith("p1", {
      connection_id: "c1",
      repository_name: "empty-one",
      carry_history: true,
      use_existing: true,
    });
  });

  it("names the files the host would reject", async () => {
    const a = api({
      startConversion: vi.fn(async () => ({
        ok: false as const,
        error: {
          status: 422,
          code: "file_rejected_by_host",
          message: "The git host would reject these files.",
          details: {
            paths: [
              { path: ".gitmodules", seq: 2 },
              { path: "a/.GIT/x", seq: null },
            ],
          },
        },
      })),
    });
    const { dialog } = mount(a);
    const user = userEvent.setup();
    await within(dialog).findByLabelText("Repository name");
    await user.click(within(dialog).getByRole("button", { name: "Convert" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "The git host would reject these files. Files: .gitmodules (commit #2), a/.GIT/x.",
    );
  });

  it("says so when no connection is at Read and write", async () => {
    const { dialog } = mount(api(), git({ connections: [member("c1", "", "read" as never)] }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      /No git connection is at Read and write/,
    );
  });
});

describe("progress and end states", () => {
  it("follows a started conversion to completed", async () => {
    const a = api({
      startConversion: vi.fn(async () => ok(attempt())),
      conversion: vi
        .fn<RepoApi["conversion"]>()
        .mockResolvedValueOnce(ok(null))
        .mockResolvedValueOnce(ok(attempt({ step: "push", commitsPushed: 1 })))
        .mockResolvedValue(ok(attempt({ status: "completed", step: "done", commitsPushed: 3 }))),
    });
    const { dialog, onChanged } = mount(a);
    const user = userEvent.setup();
    await within(dialog).findByLabelText("Repository name");
    await user.click(within(dialog).getByRole("button", { name: "Convert" }));
    expect(await within(dialog).findByText("Pushing commits: 1 of 3…")).toBeTruthy();
    expect(within(dialog).getByRole("progressbar")).toBeTruthy();
    expect(
      await within(dialog).findByText(/The project is now a Repo: acme\/kobe-q4 on github\.com/),
    ).toBeTruthy();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it("a failed conversion shows the server's words with Retry and Abandon", async () => {
    const failed = attempt({
      status: "failed",
      step: "push",
      repositoryCreated: true,
      error: { code: "push_rejected", message: "The git host refused the push.", detail: "hook" },
    });
    const a = api({
      conversion: vi.fn(async () => ok(failed)),
      abandonConversion: vi.fn(async () =>
        ok({
          conversion: { ...failed, status: "abandoned" as const },
          leftOnHost: { fullName: "acme/kobe-q4", baseUrl: "https://github.com" },
        }),
      ),
    });
    const { dialog } = mount(a);
    const user = userEvent.setup();
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "The git host refused the push. (hook)",
    );
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(a.retryConversion).toHaveBeenCalledWith("p1");
    expect(await within(dialog).findByText("Creating the repository on the host…")).toBeTruthy();
  });

  it("abandoning leaves the created repository on the host, and the form comes back", async () => {
    const failed = attempt({
      status: "failed",
      repositoryCreated: true,
      error: {
        code: "repository_exists",
        message: "A repository with that name exists.",
        detail: null,
      },
    });
    const a = api({
      conversion: vi.fn(async () => ok(failed)),
      abandonConversion: vi.fn(async () =>
        ok({
          conversion: { ...failed, status: "abandoned" as const },
          leftOnHost: { fullName: "acme/kobe-q4", baseUrl: "https://github.com" },
        }),
      ),
    });
    const { dialog } = mount(a);
    const user = userEvent.setup();
    await user.click(await within(dialog).findByRole("button", { name: "Abandon…" }));
    expect(within(dialog).getByRole("note").textContent).toMatch(/stays there/);
    await user.click(within(dialog).getByRole("button", { name: "Abandon conversion" }));
    expect(
      await within(dialog).findByText(
        "The conversion was abandoned. The repository acme/kobe-q4 stays on github.com: a Workspace admin can delete or reuse it.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText("Repository name")).toBeTruthy();
  });

  it("Escape closes it", async () => {
    const { dialog, onClose } = mount(api());
    const user = userEvent.setup();
    await within(dialog).findByLabelText("Repository name");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("review round 1", () => {
  it("says what the connection's visibility means (M2)", async () => {
    const internal = { ...member("c1", "kobe-"), repoVisibility: "internal" as const };
    const { dialog } = mount(api(), git({ connections: [internal] }));
    expect(
      await within(dialog).findByText(/^An internal repository in acme on github\.com: everyone/),
    ).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/private repository/);
  });

  it("internal is GitHub only: a Gitea or Forgejo connection is described as private", async () => {
    const forgejo = {
      ...member("c2", ""),
      provider: "forgejo" as const,
      repoVisibility: "internal" as const,
    };
    const { dialog } = mount(api(), git({ connections: [forgejo] }));
    expect(
      await within(dialog).findByText(/^A private repository in ops on git\.example\.com:/),
    ).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/internal/i);
  });

  it("an unreadable attempt is not shown as 'no conversion' (L4), and Try again reads it", async () => {
    const a = api({
      conversion: vi
        .fn<RepoApi["conversion"]>()
        .mockResolvedValueOnce({
          ok: false,
          error: { status: 502, code: "server_error", message: "x" },
        })
        .mockResolvedValue(ok(null)),
    });
    const { dialog } = mount(a);
    const retry = await within(dialog).findByRole("button", { name: "Try again" });
    expect(document.activeElement).toBe(retry);
    expect(within(dialog).queryByLabelText("Repository name")).toBeNull();
    await userEvent.setup().click(retry);
    expect(await within(dialog).findByLabelText("Repository name")).toBeTruthy();
  });

  it("stops following after failed reads and says so (L3)", async () => {
    const conversion = vi
      .fn<RepoApi["conversion"]>()
      .mockResolvedValueOnce(ok(attempt()))
      .mockResolvedValue({ ok: false, error: { status: 404, code: "not_found", message: "x" } });
    const a = api({ conversion });
    const { dialog } = mount(a);
    expect(
      await within(dialog).findByText(/could not read the conversion's progress/, undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy();
    const reads = conversion.mock.calls.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(conversion.mock.calls.length).toBe(reads);
  });

  it("the dialog itself has the focus while it reads (L6)", async () => {
    let answer: (v: ApiResult<RepoConversion | null>) => void = () => undefined;
    const a = api({
      conversion: vi.fn<RepoApi["conversion"]>(
        () =>
          new Promise<ApiResult<RepoConversion | null>>((r) => {
            answer = r;
          }),
      ),
    });
    const { dialog } = mount(a);
    expect(document.activeElement).toBe(dialog);
    answer(ok(null));
    await within(dialog).findByLabelText("Repository name");
  });
});
