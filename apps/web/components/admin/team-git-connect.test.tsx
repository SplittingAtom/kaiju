// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamGitPage } from "./team/git/git-page";
import { GIT_BASE, ID, adminConnection, list, report, tokenConnection } from "./git-test-data";
import { forbidNativeConfirm, renderTeam, stubApi, type RecordedCall } from "./testing";

const ADMIN = { permissions: ["team.git.manage"] };
const TOKEN = "github_pat_11SECRETSECRETSECRET0123456789";
const GITEA_TOKEN = "f00dfeedcafe0123456789abcdef0123456789ab";
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretkeymaterialsecretkeymaterial\n-----END RSA PRIVATE KEY-----";
const SECRET_BITS = [TOKEN, GITEA_TOKEN, "secretkeymaterial"];

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openConnect() {
  await userEvent.click(await screen.findByRole("button", { name: "Connect a git organization" }));
  return within(await screen.findByRole("dialog", { name: "Connect a git organization" }));
}

type Dialog = Awaited<ReturnType<typeof openConnect>>;

async function stepOne(d: Dialog, provider: string, address?: string) {
  await userEvent.click(d.getByRole("radio", { name: provider }));
  if (address !== undefined) {
    await userEvent.type(d.getByRole("textbox", { name: /Address/ }), address);
  }
  await userEvent.click(d.getByRole("button", { name: "Next" }));
}

async function stepTwo(
  d: Dialog,
  organization: string,
  fill: () => Promise<void>,
  level: "Off" | "Read" | "Read and write" = "Read and write",
) {
  await d.findByRole("heading", { name: /Step 2 of 3/ });
  await userEvent.type(d.getByRole("textbox", { name: /^Organization/ }), organization);
  await userEvent.click(d.getByRole("radio", { name: level }));
  await fill();
  await userEvent.click(d.getByRole("button", { name: "Next" }));
  await d.findByRole("heading", { name: /Step 3 of 3/ });
}

const typeToken = (d: Dialog, value: string) => async () => {
  await userEvent.type(d.getByLabelText(/Access token/), value);
};

const fillApp = (d: Dialog) => async () => {
  await userEvent.type(d.getByRole("textbox", { name: /App ID/ }), "4242");
  await userEvent.type(d.getByRole("textbox", { name: /Installation ID/ }), "777");
  await userEvent.click(d.getByRole("textbox", { name: "Private key" }));
  await userEvent.paste(PEM);
};

const bodyOf = (calls: RecordedCall[], method: string, url: string) =>
  JSON.parse(String(calls.find((c) => c.method === method && c.url === url)?.body)) as Record<
    string,
    unknown
  >;

/** Nothing secret left in the page: not in the markup, not in any field's live value. */
function expectNoSecretInPage() {
  const html = document.body.innerHTML;
  for (const bit of SECRET_BITS) expect(html).not.toContain(bit);
  for (const field of document.querySelectorAll("input, textarea")) {
    const value = (field as HTMLInputElement).value;
    for (const bit of SECRET_BITS) expect(value).not.toContain(bit);
  }
}

function expectSecretsOnlyInBodies(calls: RecordedCall[]) {
  for (const c of calls) {
    for (const bit of SECRET_BITS) {
      expect(c.url).not.toContain(bit);
      expect([...c.headers.values()].join(" ")).not.toContain(bit);
    }
  }
}

describe("Connect a git organization (KOBE-761 ac-1, ac-2)", () => {
  it("GitHub App on github.com: test shows capabilities, connect sends the App and clears the key", async () => {
    const saved = adminConnection();
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [
        [200, list([])],
        [200, list([saved])],
      ],
      [`POST ${GIT_BASE}/test`]: [
        200,
        {
          test: report({
            warnings: [{ code: "excess_permissions", permissions: ["members:write"] }],
          }),
        },
      ],
      [`POST ${GIT_BASE}`]: [201, { connection: saved, test: report() }],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    const d = await openConnect();
    expect(d.getByRole("heading", { name: "Step 1 of 3: Host" })).toBe(document.activeElement);
    await stepOne(d, "GitHub");
    await stepTwo(d, "acme", async () => {
      // The App is the default for GitHub, with the exact permissions and a link to the form.
      expect(d.getByRole("radio", { name: "GitHub App (recommended)" })).toHaveProperty(
        "checked",
        true,
      );
      const help = d.getByRole("list", { name: "GitHub App permissions" });
      expect(help.textContent).toMatch(/Metadata: Read/);
      expect(help.textContent).toMatch(
        /Administration: Read and write — Only if agents may create/,
      );
      expect(d.getByRole("link", { name: /New GitHub App/ }).getAttribute("href")).toBe(
        "https://github.com/organizations/acme/settings/apps/new",
      );
      await fillApp(d)();
    });
    expect(d.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", true);
    await userEvent.click(d.getByRole("button", { name: "Test" }));
    const live = d.getByRole("status");
    await within(live).findByText(/Test passed/);
    expect(live.textContent).toMatch(/Acts as.*The App's bot \(kobe-acme\[bot\]\)/);
    expect(live.textContent).toMatch(/more than Kaiju needs \(members:write\)/);
    expect(bodyOf(calls, "POST", `${GIT_BASE}/test`)).toEqual({
      provider: "github",
      organization: "acme",
      credential: { kind: "github_app", app_id: 4242, installation_id: 777, private_key: PEM },
      access_level: "read_write",
    });
    await userEvent.click(d.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Connected acme on GitHub\. The credential is stored encrypted/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bodyOf(calls, "POST", GIT_BASE)).toMatchObject({
      provider: "github",
      organization: "acme",
      access_level: "read_write",
      repo_visibility: "private",
      repo_name_prefix: "",
      default_branch: "main",
      credential: { kind: "github_app", private_key: PEM },
    });
    expectNoSecretInPage();
    expectSecretsOnlyInBodies(calls);
  });

  it("GitHub fine-grained token: unverified permissions are said, and the token never shows", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [200, list([])],
      [`POST ${GIT_BASE}/test`]: [
        200,
        {
          test: report({
            actor: { kind: "token", login: "octo" },
            capabilities: { create: "unknown", read: "yes", write: "unknown", admin: "unknown" },
            credential_expires_at: "2027-01-01T00:00:00.000Z",
            warnings: [{ code: "unverified", capabilities: ["write", "create"] }],
          }),
        },
      ],
      [`POST ${GIT_BASE}`]: [201, { connection: tokenConnection(), test: report() }],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    const d = await openConnect();
    await stepOne(d, "GitHub");
    await stepTwo(d, "acme", async () => {
      await userEvent.click(d.getByRole("radio", { name: "Fine-grained personal access token" }));
      expect(d.getByRole("link", { name: /New fine-grained token/ }).getAttribute("href")).toBe(
        "https://github.com/settings/personal-access-tokens/new",
      );
      const field = d.getByLabelText(/Access token/) as HTMLInputElement;
      expect(field.type).toBe("password");
      await typeToken(d, TOKEN)();
      // Uncontrolled: React never mirrors the secret into the value attribute.
      expect(field.getAttribute("value")).toBeNull();
      expect(document.body.innerHTML).not.toContain(TOKEN);
    });
    await userEvent.click(d.getByRole("button", { name: "Test" }));
    const live = d.getByRole("status");
    await within(live).findByText(/Test passed/);
    expect(live.textContent).toMatch(/The token's owner, octo/);
    expect(live.textContent).toMatch(/cannot report this credential's permissions/);
    expect(live.textContent).toMatch(/Not known until first use/);
    expect(bodyOf(calls, "POST", `${GIT_BASE}/test`)["credential"]).toEqual({
      kind: "access_token",
      token: TOKEN,
    });
    await userEvent.click(d.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Connected infra on Forgejo/);
    expectNoSecretInPage();
    expectSecretsOnlyInBodies(calls);
  });

  it("GitHub Enterprise Server: sends the address as base_url with provider github", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [200, list([])],
      [`POST ${GIT_BASE}/test`]: [200, { test: report() }],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    const d = await openConnect();
    await stepOne(d, "GitHub Enterprise Server", "https://GHE.corp.example/");
    await stepTwo(d, "eng", async () => {
      expect(d.getByRole("link", { name: /New GitHub App/ }).getAttribute("href")).toBe(
        "https://ghe.corp.example/organizations/eng/settings/apps/new",
      );
      await fillApp(d)();
    });
    await userEvent.click(d.getByRole("button", { name: "Test" }));
    await within(d.getByRole("status")).findByText(/Test passed/);
    expect(bodyOf(calls, "POST", `${GIT_BASE}/test`)).toMatchObject({
      provider: "github",
      base_url: "https://ghe.corp.example",
      organization: "eng",
    });
  });

  it.each([
    ["Gitea", "gitea", "https://git.example.com"],
    ["Forgejo", "forgejo", "https://codeberg.org"],
  ])(
    "%s: token only, with the scopes to choose and the host's token page",
    async (label, provider, address) => {
      const calls = stubApi({
        [`GET ${GIT_BASE}`]: [200, list([])],
        [`POST ${GIT_BASE}/test`]: [
          200,
          {
            test: report({
              provider: provider as "gitea",
              actor: { kind: "token", login: "kobe-bot" },
            }),
          },
        ],
        [`POST ${GIT_BASE}`]: [201, { connection: tokenConnection(), test: report() }],
      });
      renderTeam(<TeamGitPage />, ADMIN);
      const d = await openConnect();
      await stepOne(d, label, address);
      await stepTwo(d, "ops", async () => {
        expect(d.queryByRole("radio", { name: /GitHub App/ })).toBeNull();
        const scopes = d.getByRole("list", { name: `${label} token scopes` });
        for (const s of [
          "read:user",
          "read:organization",
          "write:organization",
          "write:repository",
          "write:issue",
        ]) {
          expect(scopes.textContent).toContain(s);
        }
        expect(d.getByRole("link", { name: /Settings › Applications/ }).getAttribute("href")).toBe(
          `${address}/user/settings/applications`,
        );
        await typeToken(d, GITEA_TOKEN)();
      });
      // No internal repositories on Gitea or Forgejo.
      expect(d.queryByRole("option", { name: /Internal/ })).toBeNull();
      await userEvent.type(d.getByRole("textbox", { name: "Display name" }), "Ops code");
      await userEvent.click(d.getByRole("button", { name: "Test" }));
      await within(d.getByRole("status")).findByText(/Test passed/);
      await userEvent.click(d.getByRole("button", { name: "Connect" }));
      await screen.findByText(/Connected infra on Forgejo/);
      expect(bodyOf(calls, "POST", GIT_BASE)).toMatchObject({
        provider,
        base_url: address,
        organization: "ops",
        display_name: "Ops code",
        credential: { kind: "access_token", token: GITEA_TOKEN },
      });
      expectNoSecretInPage();
      expectSecretsOnlyInBodies(calls);
    },
  );
});

describe("Connect: checks and errors (KOBE-761)", () => {
  it("refuses an http address, and a host the Site does not allow, before sending", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [
        200,
        list([], { site: { enabled: true, allowed_hosts: ["*.corp.example"] } }),
      ],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    const d = await openConnect();
    // github.com itself is outside the list.
    await stepOne(d, "GitHub");
    expect(await d.findByText(/does not allow git connections to github.com/)).toBeTruthy();
    await stepOne(d, "Gitea", "http://git.corp.example");
    expect(await d.findByText("The address must use https.")).toBeTruthy();
    await userEvent.clear(d.getByRole("textbox", { name: /Address/ }));
    await userEvent.type(d.getByRole("textbox", { name: /Address/ }), "https://git.other.org");
    await userEvent.click(d.getByRole("button", { name: "Next" }));
    expect(await d.findByText(/does not allow git connections to git.other.org/)).toBeTruthy();
    expect(d.getByText(/This Site allows: \*\.corp\.example/)).toBeTruthy();
    await userEvent.clear(d.getByRole("textbox", { name: /Address/ }));
    await userEvent.type(d.getByRole("textbox", { name: /Address/ }), "https://git.corp.example");
    await userEvent.click(d.getByRole("button", { name: "Next" }));
    await d.findByRole("heading", { name: /Step 2 of 3/ });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("step 2 says what is missing: organization, token, App ids and key", async () => {
    stubApi({ [`GET ${GIT_BASE}`]: [200, list([])] });
    renderTeam(<TeamGitPage />, ADMIN);
    const d = await openConnect();
    await stepOne(d, "GitHub");
    await d.findByRole("heading", { name: /Step 2 of 3/ });
    await userEvent.click(d.getByRole("button", { name: "Next" }));
    expect(await d.findByText(/Enter the organization's name/)).toBeTruthy();
    expect(d.getByText("Enter the App ID (a number).")).toBeTruthy();
    expect(d.getByText("Enter the installation ID (a number).")).toBeTruthy();
    expect(d.getByText(/Add the App's private key/)).toBeTruthy();
    await userEvent.click(d.getByRole("textbox", { name: "Private key" }));
    await userEvent.paste(
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\n-----END ENCRYPTED PRIVATE KEY-----",
    );
    await userEvent.click(d.getByRole("button", { name: "Next" }));
    expect(await d.findByText(/An encrypted key cannot be used/)).toBeTruthy();
    await userEvent.click(d.getByRole("radio", { name: "Fine-grained personal access token" }));
    await userEvent.click(d.getByRole("button", { name: "Next" }));
    expect(await d.findByText("Paste the access token.")).toBeTruthy();
    await typeToken(d, "has space")();
    await userEvent.click(d.getByRole("button", { name: "Next" }));
    expect(await d.findByText(/without spaces or line breaks/)).toBeTruthy();
    // The error never repeats the value.
    expect(document.body.innerHTML).not.toContain("has space");
  });

  it("refuses a private key over 8 KiB at once, pasted or from a file, and sends nothing", async () => {
    const calls = stubApi({ [`GET ${GIT_BASE}`]: [200, list([])] });
    renderTeam(<TeamGitPage />, ADMIN);
    const d = await openConnect();
    await stepOne(d, "GitHub");
    await d.findByRole("heading", { name: /Step 2 of 3/ });
    const big = `-----BEGIN RSA PRIVATE KEY-----\n${"A".repeat(9000)}\n-----END RSA PRIVATE KEY-----`;
    await userEvent.click(d.getByRole("textbox", { name: "Private key" }));
    await userEvent.paste(big);
    expect(
      await d.findByText(/too long for a private key: Kaiju accepts up to 8 KiB/),
    ).toBeTruthy();
    await userEvent.click(d.getByRole("button", { name: "Next" }));
    expect(d.getByRole("heading", { name: /Step 2 of 3/ })).toBeTruthy();
    await userEvent.clear(d.getByRole("textbox", { name: "Private key" }));
    expect(d.queryByText(/too long for a private key/)).toBeNull();
    await userEvent.upload(
      d.getByLabelText("Private key file"),
      new File([big], "big.pem", { type: "application/x-pem-file" }),
    );
    expect(await d.findByText(/too long for a private key/)).toBeTruthy();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("loads the private key from a file without showing it", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [200, list([])],
      [`POST ${GIT_BASE}/test`]: [200, { test: report() }],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    const d = await openConnect();
    await stepOne(d, "GitHub");
    await stepTwo(d, "acme", async () => {
      await userEvent.type(d.getByRole("textbox", { name: /App ID/ }), "1");
      await userEvent.type(d.getByRole("textbox", { name: /Installation ID/ }), "2");
      await userEvent.upload(
        d.getByLabelText("Private key file"),
        new File([PEM], "acme.private-key.pem", { type: "application/x-pem-file" }),
      );
      expect(await d.findByText(/Loaded from acme.private-key.pem/)).toBeTruthy();
      expect(document.body.innerHTML).not.toContain("secretkeymaterial");
    });
    await userEvent.click(d.getByRole("button", { name: "Test" }));
    await within(d.getByRole("status")).findByText(/Test passed/);
    expect(bodyOf(calls, "POST", `${GIT_BASE}/test`)["credential"]).toMatchObject({
      private_key: PEM,
    });
  });

  it("maps a failed test to Kaiju's words and keeps Connect off; an edit drops an old pass", async () => {
    stubApi({
      [`GET ${GIT_BASE}`]: [200, list([])],
      [`POST ${GIT_BASE}/test`]: [
        [
          422,
          {
            code: "credential_rejected",
            message: "host said something",
            test: { code: "auth_failed", reason: "installation_removed" },
          },
        ],
        [502, { code: "host_unreachable", message: "x", test: { code: "host_unreachable" } }],
        [
          200,
          {
            test: report({
              ok: false,
              missing: ["write"],
              capabilities: { create: "no", read: "yes", write: "no", admin: "no" },
            }),
          },
        ],
        [200, { test: report() }],
      ],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    const d = await openConnect();
    await stepOne(d, "GitHub");
    await stepTwo(d, "acme", fillApp(d));
    const test = d.getByRole("button", { name: "Test" });
    const connect = d.getByRole("button", { name: "Connect" });
    await userEvent.click(test);
    expect(await d.findByText(/not installed on this organization/)).toBeTruthy();
    expect(d.queryByText("host said something")).toBeNull();
    expect(connect).toHaveProperty("disabled", true);
    await userEvent.click(test);
    expect(await d.findByText(/could not reach the host/)).toBeTruthy();
    await userEvent.click(test);
    expect(await d.findByText(/Test failed: the credential cannot push/)).toBeTruthy();
    expect(connect).toHaveProperty("disabled", true);
    await userEvent.click(test);
    await d.findByText(/Test passed/);
    expect(connect).toHaveProperty("disabled", false);
    await userEvent.click(d.getByRole("button", { name: "Back" }));
    await userEvent.type(d.getByRole("textbox", { name: /^Organization/ }), "x");
    await userEvent.click(d.getByRole("button", { name: "Next" }));
    expect(d.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", true);
  });

  it("shows the cap and duplicate refusals from Connect", async () => {
    stubApi({
      [`GET ${GIT_BASE}`]: [200, list([])],
      [`POST ${GIT_BASE}/test`]: [200, { test: report() }],
      [`POST ${GIT_BASE}`]: [
        409,
        {
          code: "connection_limit",
          message: "A Workspace can have at most 5 git connections. Disconnect one first.",
        },
      ],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    const d = await openConnect();
    await stepOne(d, "GitHub");
    await stepTwo(d, "acme", fillApp(d));
    await userEvent.click(d.getByRole("button", { name: "Test" }));
    await d.findByText(/Test passed/);
    await userEvent.click(d.getByRole("button", { name: "Connect" }));
    expect(await d.findByText(/at most 5 git connections/)).toBeTruthy();
    expectNoSecretInPageExceptOpenFields();
  });

  it("drops the secret when the dialog is cancelled: reopening starts empty", async () => {
    stubApi({ [`GET ${GIT_BASE}`]: [200, list([])] });
    renderTeam(<TeamGitPage />, ADMIN);
    let d = await openConnect();
    await stepOne(d, "Forgejo", "https://codeberg.org");
    await d.findByRole("heading", { name: /Step 2 of 3/ });
    await typeToken(d, GITEA_TOKEN)();
    await userEvent.click(d.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expectNoSecretInPage();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Connect a git organization" }),
    );
    d = await openConnect();
    expect(d.getByRole("heading", { name: /Step 1 of 3/ })).toBeTruthy();
  });
});

describe("Replace credential (KOBE-761 ac-1, ac-2)", () => {
  it("tests and replaces a token, then clears it; a refusal is said in Kaiju's words", async () => {
    const calls = stubApi({
      [`GET ${GIT_BASE}`]: [200, list([tokenConnection({ id: ID })])],
      [`PUT ${GIT_BASE}/${ID}/credential`]: [
        [
          422,
          {
            code: "credential_forbidden",
            message: "x",
            test: { code: "forbidden", missing_permission: "write:issue" },
          },
        ],
        [200, { connection: tokenConnection({ id: ID }), test: report() }],
      ],
    });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByRole("article", { name: "infra on Forgejo" });
    await userEvent.click(
      screen.getByRole("button", { name: "Replace credential for infra on Forgejo" }),
    );
    const d = within(
      await screen.findByRole("dialog", { name: "Replace the credential of infra on Forgejo" }),
    );
    expect(d.getByRole("list", { name: "Forgejo token scopes" })).toBeTruthy();
    await typeToken(d, GITEA_TOKEN)();
    await userEvent.click(d.getByRole("button", { name: "Test and replace" }));
    expect(await d.findByText(/lacks a permission the host asked for: write:issue/)).toBeTruthy();
    await userEvent.click(d.getByRole("button", { name: "Test and replace" }));
    await screen.findByText(
      /Replaced the credential of infra on Forgejo\. The old one is discarded\./,
    );
    expect(JSON.parse(String(calls.filter((c) => c.method === "PUT")[1]?.body))).toEqual({
      credential: { kind: "access_token", token: GITEA_TOKEN },
    });
    expectNoSecretInPage();
    expectSecretsOnlyInBodies(calls);
  });

  it("offers both GitHub credential kinds for a GitHub connection", async () => {
    stubApi({ [`GET ${GIT_BASE}`]: [200, list([adminConnection()])] });
    renderTeam(<TeamGitPage />, ADMIN);
    await screen.findByRole("article", { name: "acme on GitHub" });
    await userEvent.click(
      screen.getByRole("button", { name: "Replace credential for acme on GitHub" }),
    );
    const d = within(await screen.findByRole("dialog"));
    expect(d.getByRole("radio", { name: "GitHub App (recommended)" })).toHaveProperty(
      "checked",
      true,
    );
    expect(d.getByRole("radio", { name: "Fine-grained personal access token" })).toBeTruthy();
  });
});

/** After a refused Connect the dialog is still open: no secret in markup or attributes. */
function expectNoSecretInPageExceptOpenFields() {
  const html = document.body.innerHTML;
  for (const bit of SECRET_BITS) expect(html).not.toContain(bit);
}
