import type { Browser, Locator, Page } from "@playwright/test";
import { Chat, expect, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";
import { pinTeam } from "./support/team.js";
import { uniqueWords } from "./support/unique.js";

/**
 * Gate C (KOBE-407): a fact a member states in a conversation travels to the Site in two steps
 * and comes back as a Site memory. member2 (KOBE_USER2, a plain member) asks a no-tools question
 * that states a unique office fact (the name of a meeting room), runs Learn from this chat and proposes the candidate
 * to the Site with a justification (KOBE-404); My memory › Your Site proposals shows it waiting
 * for a Team admin. The owner (KOBE_USER, Team admin and Site admin) confirms it with an edit on
 * Workspace console › Memory › To the Site; on Site console › Memory › Proposals the detail shows
 * statement, kind, justification, source Workspace and date and none of the conversation
 * (KOBE-405, KOBE-406), and the owner requests changes; the note and the round come back to To the
 * Site, the owner confirms again and approves it on the Site. member2 then reads it as a Site
 * memory that names no Workspace, and Your Site proposals says Approved. Light and dark
 * screenshots of the Site console detail and the To the Site tab are attached. The Site memory is
 * archived at the end; the phrase is unique per run. Needs the memory switches on (Site and
 * workspace, Learn, Members may propose to the Site) and a learning model. Spends one short model
 * turn and one learning pass: `npx playwright test site-proposals`.
 */
const SECOND_USER = process.env["KOBE_USER2"];
const SECOND_PW = process.env["KOBE_PW2"];
/**
 * KOBE_USER3/KOBE_PW3 (k3d's Gate 7): another Team admin of the workspace who confirms at step 2.
 * Nobody decides a proposal they confirmed (KOBE-666), and KOBE_USER decides on the Site at steps
 * 3 and 5, so without a third member the run would stop at the disabled Site actions and leave a
 * proposal only another Site curator can decide: the spec skips instead.
 */
const THIRD_USER = process.env["KOBE_USER3"];
const THIRD_PW = process.env["KOBE_PW3"];
const TEAM_KEY = "kobe.lastTeamId";
const PASS_TIMEOUT_MS = 180_000;
/** The parts of member2's question that are not the fact: never shown to the Site. */
const CONVERSATION_ONLY = ["No tools", "Reply with the single word"];

async function shoot(page: Page, name: string, target: Locator): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await test.info().attach(`${name}-${theme}.png`, {
      body: await target.screenshot({ animations: "disabled" }),
      contentType: "image/png",
    });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** member2 (or another user), signed in in a fresh context (no saved session), in the pinned team. */
async function signInSecond(
  browser: Browser,
  email = SECOND_USER,
  password = SECOND_PW,
): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email ?? "");
  await page.getByLabel("Password").fill(password ?? "");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
    timeout: SHELL_TIMEOUT_MS,
  });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await pinTeam(page);
  return page;
}

/** The composer's + › Memory submenu (learn-from-chat.spec.ts). */
async function openMemoryMenu(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Add to your message", exact: true }).click();
  const menu = page.locator("[data-kaiju-plus-menu]");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Memory/ }).hover();
  const sub = page.locator("[data-kaiju-memory-menu]");
  await expect(sub).toBeVisible();
  return sub;
}

/**
 * Learn from this chat, then To review for this thread with the candidate naming `word`. Fails
 * with what the install said when Learn is unavailable or the pass finds no such candidate: this
 * is a gate check, not optional.
 */
async function learnCandidate(page: Page, threadId: string, word: string): Promise<Locator> {
  const sub = await openMemoryMenu(page);
  const learn = sub.getByRole("menuitem", { name: /^Learn from this chat/ });
  await expect(learn).toBeVisible();
  if ((await learn.getAttribute("aria-disabled")) === "true") {
    throw new Error(
      `Learn from this chat is unavailable for member2: "${(await learn.textContent()) ?? ""}"`,
    );
  }
  await learn.click();
  const plus = page.getByRole("button", { name: "Add to your message", exact: true });
  const notice = page.locator("[data-kaiju-learn-notice]");
  const panel = panelOf(page);
  // The pass starts (the + shows the spinner, or To review is already open), then ends:
  // candidates open To review by itself (KOBE-396, KOBE-661); otherwise the + settles.
  await expect(async () => {
    if (await panel.isVisible()) return;
    expect(await plus.getAttribute("data-kaiju-learn-state", { timeout: 1_000 })).toBe("spinner");
  }).toPass({ timeout: SHELL_TIMEOUT_MS });
  await expect(async () => {
    if (await panel.isVisible()) return;
    expect(await plus.getAttribute("data-kaiju-learn-state", { timeout: 1_000 })).not.toBe(
      "spinner",
    );
  }).toPass({ timeout: PASS_TIMEOUT_MS });
  const said = (await notice.isVisible()) ? ((await notice.textContent()) ?? "") : "";
  if (!(await panel.isVisible())) {
    await page.goto(`/me/memory?review=1&thread=${encodeURIComponent(threadId)}`);
  }
  const candidates = panel.getByRole("list", { name: "Candidates" });
  // Cards are the list's own items (a card has nested items of its own, e.g. its quotes).
  const card = candidates.locator(":scope > li").filter({ hasText: word });
  // To review may have loaded before the pass stored its candidates: read it again once.
  if ((await card.count()) === 0) {
    await page.waitForTimeout(3_000);
    await page.goto(`/me/memory?review=1&thread=${encodeURIComponent(threadId)}`);
  }
  await expect(card, `the learning pass found no candidate naming "${word}" (${said})`).toHaveCount(
    1,
    { timeout: SHELL_TIMEOUT_MS },
  );
  return card;
}

/** Workspace console › Memory › To the Site, the tab's panel. */
async function toTheSite(page: Page): Promise<Locator> {
  await page.goto("/admin/team/memory");
  const panel = panelOf(page);
  await panel.getByRole("tab", { name: "To the Site" }).click({ timeout: SHELL_TIMEOUT_MS });
  const tab = panel.getByRole("tabpanel");
  await expect(tab.getByText("Loading Site proposals…")).toHaveCount(0, {
    timeout: SHELL_TIMEOUT_MS,
  });
  return tab;
}

/** The proposal's card in To the Site's "Waiting for a Team admin" group. */
function waitingCard(tab: Locator, word: string): Locator {
  return tab
    .getByRole("list", { name: "Waiting for a Team admin" })
    .getByRole("article")
    .filter({ hasText: word });
}

/** Site console › Memory › Proposals (waiting for the Site): opens the proposal's detail. */
async function openSiteProposal(page: Page, word: string): Promise<Locator> {
  await page.goto("/admin/site/memory");
  const panel = panelOf(page);
  await panel.getByRole("tab", { name: "Proposals" }).click({ timeout: SHELL_TIMEOUT_MS });
  const row = panel
    .getByRole("list", { name: "Site proposals" })
    .locator(":scope > li")
    .filter({ hasText: word });
  await expect(row).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
  await row.getByRole("button", { name: /^Review: / }).click();
  const detail = panel
    .getByRole("region")
    .filter({ hasText: "Why every workspace should know this:" })
    .last();
  await expect(detail).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  return detail;
}

/** member2's Site memory, found through the member's own API (its id opens it in My memory). */
async function siteItemId(page: Page, word: string): Promise<string | null> {
  return page.evaluate(
    async ({ word, teamKey }) => {
      const team = window.localStorage.getItem(teamKey) ?? "";
      const res = await fetch(
        "/v1/memory/semantic/items?scope=site&status=active&pinned=false&limit=100",
        { headers: { "x-kobe-team": team } },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { items: { id: string; statement: string }[] };
      return body.items.find((i) => i.statement.includes(word))?.id ?? null;
    },
    { word, teamKey: TEAM_KEY },
  );
}

test("a member's fact goes to the Site: propose, confirm, request changes, approve", async ({
  page,
  browser,
}) => {
  test.skip(!SECOND_USER || !SECOND_PW, "KOBE_USER2 and KOBE_PW2 name a second member");
  test.skip(
    !THIRD_USER || !THIRD_PW,
    "KOBE_USER3 and KOBE_PW3 name another Team admin: whoever confirms may not decide (KOBE-666)",
  );
  test.setTimeout(15 * 60_000);
  const [first = "", second = ""] = uniqueWords().split(" ");
  const phrase = `${first} ${second}`;
  const justification = `E2E ${first}: every Workspace books this room.`;
  const changesNote = `E2E ${first}: please say which office this is for.`;

  const member = await signInSecond(browser);
  const memberChat = new Chat(member);
  const confirmer = await signInSecond(browser, THIRD_USER, THIRD_PW);
  let approved = false;
  try {
    // 1. member2: the fact in a conversation, Learn, Propose… › The Site.
    await memberChat.open();
    const threadId = await memberChat.ask(
      `No tools. Reply with the single word OK. For the record: our office's big meeting room is called the ${phrase} room.`,
    );
    const card = await learnCandidate(member, threadId, first);
    const proposed = ((await card.locator("[data-review-statement]").textContent()) ?? "").trim();
    expect(proposed).toContain(first);
    await card.getByRole("button", { name: "Propose…" }).click();
    const form = card.getByRole("group", { name: "Propose" });
    const toSite = form.getByRole("radio", { name: /^The Site \(every workspace\)/ });
    await expect(toSite, "Propose… › The Site is disabled for this candidate").toBeEnabled();
    if (!(await toSite.isChecked())) await toSite.check();
    await form.getByLabel(/^Why every workspace should know this/).fill(justification);
    await form.getByRole("button", { name: "Propose to the Site" }).click();
    const memberPanel = panelOf(member);
    await expect(
      memberPanel.getByText(/^Proposed to the Site\. A Team admin confirms it first/),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    await member.goto("/me/memory");
    const mine = memberPanel
      .getByRole("list", { name: "Your Site proposals" })
      .getByRole("article")
      .filter({ hasText: first });
    await expect(mine).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
    await expect(mine).toContainText("A Team admin confirms it before it goes to the Site.");

    // 2. the confirmer (KOBE_USER3): To the Site lists it with the justification; Edit and confirm.
    const confirmed = `${proposed} (confirmed)`;
    let tab = await toTheSite(confirmer);
    let waiting = waitingCard(tab, first);
    await expect(waiting).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
    await expect(waiting).toContainText(justification);
    await shoot(confirmer, "to-the-site", tab);
    await waiting.getByRole("button", { name: "Edit and confirm…" }).click();
    await waiting.getByLabel(/^Statement/).fill(confirmed);
    await waiting.getByRole("button", { name: "Confirm edited" }).click();
    await expect(
      tab.getByText(/^Confirmed: it waits for the Site's admins and memory stewards\./),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    // 3. owner: the Site's detail shows what left the Workspace and nothing of the conversation.
    let detail = await openSiteProposal(page, first);
    await expect(detail.getByRole("heading", { name: confirmed })).toBeVisible();
    const about = detail.getByRole("list", { name: "About this proposal" });
    await expect(about).toContainText(/Fact|Convention|Definition|Decision|Preference/);
    const today = await page.evaluate(() => new Date().toLocaleDateString());
    await expect(about).toContainText(`Proposed ${today}`);
    const from = about.getByRole("listitem").filter({ hasText: /^From / });
    await expect(from).toHaveCount(1);
    const workspace = ((await from.textContent()) ?? "").replace(/^From /, "").trim();
    expect(workspace).not.toBe("");
    await expect(detail).toContainText(justification);
    for (const words of CONVERSATION_ONLY) await expect(detail).not.toContainText(words);
    await shoot(page, "site-proposal-detail", detail);
    await detail.getByRole("button", { name: "Request changes…" }).click();
    await detail.getByLabel(/^What should change/).fill(changesNote);
    await detail.getByRole("button", { name: "Send back for changes" }).click();
    await expect(panelOf(page).getByText(/^Sent back to the workspace's Team admins/)).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });

    // 4. the confirmer: back on To the Site with the note and the round; Confirm again.
    tab = await toTheSite(confirmer);
    waiting = waitingCard(tab, first);
    await expect(waiting).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
    await expect(waiting).toContainText(changesNote);
    await expect(waiting).toContainText("The Site asked for changes (1 of at most");
    await expect(waiting.getByRole("list", { name: "About this proposal" })).toContainText(
      "Round 2",
    );
    await waiting.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(
      tab.getByText(/^Confirmed: it waits for the Site's admins and memory stewards\./),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    // 5. owner: Approve on the Site (saving over check warnings if the checks raise any).
    detail = await openSiteProposal(page, first);
    await expect(detail.getByRole("heading", { name: confirmed })).toBeVisible();
    await detail.getByRole("button", { name: "Approve", exact: true }).click();
    const done = panelOf(page).getByText(/^Approved: it is a Site memory now/);
    const anyway = detail.getByRole("button", { name: "Save anyway" });
    await expect(done.or(anyway)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    if (await anyway.isVisible()) await anyway.click();
    await expect(done).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    approved = true;

    // 6. member2: a Site memory with the confirmed wording, no Workspace named; Approved.
    let itemId: string | null = null;
    await expect
      .poll(async () => (itemId = await siteItemId(member, first)), {
        timeout: SHELL_TIMEOUT_MS,
        message: "member2 cannot read the approved Site memory",
      })
      .not.toBeNull();
    await member.goto(`/me/memory?item=${encodeURIComponent(itemId ?? "")}&scope=site`);
    const opened = memberPanel.getByRole("region", { name: "Opened from a conversation" });
    await expect(opened).toContainText(
      "Workspace and Site memories are changed by their curators.",
      {
        timeout: SHELL_TIMEOUT_MS,
      },
    );
    const item = opened.getByRole("list", { name: "Opened memory" }).getByRole("listitem");
    await expect(item).toContainText(confirmed);
    await expect(item.getByRole("button", { name: /^(Edit|Archive): / })).toHaveCount(0);
    await expect(opened).not.toContainText(workspace);
    await expect(opened).not.toContainText(justification);

    const outcome = memberPanel
      .getByRole("list", { name: "Your Site proposals" })
      .getByRole("article")
      .filter({ hasText: first });
    await expect(outcome).toContainText("Approved: a Site memory", { timeout: SHELL_TIMEOUT_MS });
  } finally {
    // Clean-up: archive the Site memory (memories are never deleted), trash member2's thread.
    if (approved) {
      try {
        await page.goto("/admin/site/memory");
        const panel = panelOf(page);
        const row = panel
          .getByRole("list", { name: "Site memories" })
          .locator(":scope > li")
          .filter({ hasText: first });
        await row.getByRole("button", { name: /^Archive: / }).click({ timeout: SHELL_TIMEOUT_MS });
        await expect(panel.getByText("Archived.", { exact: true })).toBeVisible({
          timeout: SHELL_TIMEOUT_MS,
        });
      } catch (e) {
        console.warn(`could not archive the Site memory naming "${first}": ${String(e)}`);
      }
    }
    await memberChat.trashAll();
    await member.context().close();
    await confirmer.context().close();
  }
});
