import type { Page } from "@playwright/test";
import { expect, filesSection, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { styleViolations, watchStyleViolations } from "./support/csp.js";

/**
 * KOBE-808 (run with KAIJU_TEAM=team1): code completion in a `.py` file's editor. Before the
 * kernel runs, the editor's built-in completion works (`pri` offers `print`) and the note under it
 * says why kernel completion is off; after Run, the conversation's kernel adds a variable the run
 * set, a DataFrame's columns (marked "kernel") and a call's signature, and Tab accepts. The
 * completion list and tooltips raise no style-src CSP violation. One short model turn creates the
 * thread; the folder is deleted at the end. (Written with the repo's conventions; needs the gate
 * install.)
 */
const TEAM_KEY = "kobe.lastTeamId";

const SOURCE =
  "import pandas as pd\n" +
  "df = pd.DataFrame({'alpha_col': [1], 'beta_col': [2]})\n" +
  // Labels kept as Python objects: the sandbox's pandas stores str labels in PyArrow, which the
  // resolver does not read (docs/guide/files/notebooks.md; images/sandbox/test-image.sh does too).
  "df.columns = pd.Index(['alpha_col', 'beta_col'], dtype=object)\n" +
  // Set through globals(), not an assignment the editor can read: a name defined in the file is
  // offered by the editor's own completion, and the kernel's duplicate is dropped (no "kernel").
  'globals()["kaiju_live_value"] = 41\n';

async function workspace(page: Page, op: "upload" | "delete", path: string, content = "") {
  return page.evaluate(
    async ({ op, path, content, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      if (op === "delete") {
        const q = encodeURIComponent(path);
        return (await fetch(`/v1/workspace/files?path=${q}`, { method: "DELETE", headers })).status;
      }
      const slash = path.lastIndexOf("/");
      const form = new FormData();
      form.set("path", path.slice(0, slash));
      form.set("file", new File([content], path.slice(slash + 1), { type: "text/plain" }));
      return (await fetch("/v1/workspace/files", { method: "POST", headers, body: form })).status;
    },
    { op, path, content, teamKey: TEAM_KEY },
  );
}

test("code completion: built-in first, then the kernel's variables, columns and signatures", async ({
  chat,
  page,
}) => {
  test.setTimeout(3 * RUN_TIMEOUT_MS);
  const dir = `kobe-808-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await chat.open();
  await watchStyleViolations(page);
  expect(await workspace(page, "upload", `${dir}/job.py`, SOURCE)).toBe(201);
  try {
    // The kernel belongs to a conversation: one short turn creates it.
    await chat.ask("Reply with the single word OK.");
    const files = filesSection(page);
    await files.getByRole("button", { name: "Refresh files" }).click();
    const tree = files.getByRole("tree", { name: "My files" });
    await tree.getByRole("treeitem", { name: dir, exact: true }).click();
    await tree.getByRole("treeitem", { name: "job.py", exact: true }).click();
    const editor = page.getByLabel("Edit job.py");
    await expect(editor).toBeVisible();
    const note = page.locator("[data-kaiju-kernel-completion]");
    const list = page.locator(".cm-tooltip-autocomplete");

    // Run first (Run uses the saved file): the run sets the variables the kernel then offers.
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.locator('[data-kaiju-kernel="idle"]')).toBeVisible({
      timeout: RUN_TIMEOUT_MS,
    });

    // A live variable from the run, marked "kernel"; Tab accepts it.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("kobe_li");
    const live = list.getByRole("option", { name: /kaiju_live_value/u });
    await expect(live).toBeVisible({ timeout: 10_000 });
    await expect(live).toContainText("kernel");
    await expect(note).toHaveText("Kernel completion on");
    await page.keyboard.press("Tab");
    await expect(editor).toContainText("kaiju_live_value");

    // A DataFrame's columns after `df['`, and the built-in completion alongside.
    await page.keyboard.press("Enter");
    await page.keyboard.type("df['al");
    await expect(list.getByRole("option", { name: /alpha_col/u })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    // Close the subscript: an open `[` (and string) would hold the lines below inside it, and
    // the call further down would then not parse as a call (no signature help).
    await page.keyboard.type("pha_col']");
    await page.keyboard.press("Enter");
    await page.keyboard.type("pri");
    await expect(list.getByRole("option", { name: /^print/u })).toBeVisible();
    await page.keyboard.press("Escape");

    // Signature help while typing a call's arguments: text, from the kernel.
    await page.keyboard.press("Enter");
    await page.keyboard.type("pd.read_csv(");
    await expect(page.locator(".cm-kaiju-doc-signature")).toContainText("read_csv(", {
      timeout: 10_000,
    });

    // Restart: no kernel now, so kernel completion says why and built-in completion still works.
    await page.keyboard.press("Escape");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(page.getByText("Kernel restarted: its variables are cleared.")).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\nkobe_li");
    await expect(note).toHaveText("Kernel completion off: the kernel is not started", {
      timeout: 10_000,
    });
    expect(await styleViolations(page)).toEqual([]);
  } finally {
    await workspace(page, "delete", dir);
  }
});
