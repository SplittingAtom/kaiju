import type { Page } from "@playwright/test";
import { expect, filesSection, test } from "./support/chat.js";

/**
 * KOBE-801: a PDF opens in the artifact column's PDF viewer (pdf.js on a canvas, its worker from
 * the app's own origin, the page CSP unchanged). Uploads a three-page PDF built here (and a
 * broken one) into `kobe-801-*\/`, opens it from Files, pages, zooms, finds text, selects it,
 * and deletes the folder at the end. No model turn.
 */
const TEAM_KEY = "kobe.lastTeamId";

/** A valid PDF, one Helvetica line per page, with the cross-reference offsets it needs. */
function pdf(pages: readonly string[]): string {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: number[] = [];
  for (const text of pages) {
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const content = objects.length;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.7\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

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
      form.set("file", new File([content], path.slice(slash + 1), { type: "application/pdf" }));
      return (await fetch("/v1/workspace/files", { method: "POST", headers, body: form })).status;
    },
    { op, path, content, teamKey: TEAM_KEY },
  );
}

test("PDF viewer: pages, zoom, fit, find and selection; a broken PDF says so", async ({
  chat,
  page,
}) => {
  const dir = `kobe-801-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await chat.open();
  expect(
    await workspace(page, "upload", `${dir}/report.pdf`, pdf(["Alpha page", "Beta page", "Gamma"])),
  ).toBe(201);
  expect(await workspace(page, "upload", `${dir}/broken.pdf`, "%PDF-1.7 not a pdf")).toBe(201);
  try {
    const files = filesSection(page);
    await files.getByRole("button", { name: "Refresh files" }).click();
    const tree = files.getByRole("tree", { name: "My files" });
    const row = (name: string) => tree.getByRole("treeitem", { name, exact: true });
    await row(dir).click();
    await row("report.pdf").click();

    const tab = page
      .getByRole("tabpanel")
      .filter({ has: page.getByRole("toolbar", { name: "PDF controls" }) });
    const pages = tab.getByRole("region", { name: /^report\.pdf, page \d+ of 3$/ });
    await expect(pages).toHaveAccessibleName("report.pdf, page 1 of 3");
    const first = tab.getByRole("group", { name: "Page 1 of 3" });
    await expect(first).toHaveAttribute("data-rendered", "true");
    await expect(first.locator("canvas")).toHaveCount(1);
    // The text layer: real, selectable text over the canvas.
    await expect(first.locator(".textLayer")).toContainText("Alpha page");

    // Navigation by button and by the page field.
    await tab.getByRole("button", { name: "Next page" }).click();
    await expect(tab.getByRole("textbox", { name: "Page number" })).toHaveValue("2");
    await tab.getByRole("textbox", { name: "Page number" }).fill("3");
    await tab.getByRole("textbox", { name: "Page number" }).press("Enter");
    await expect(pages).toHaveAccessibleName("report.pdf, page 3 of 3");

    // Zoom and fit, by mouse and keys.
    const zoom = tab.getByRole("status", { name: "Zoom" });
    const before = await zoom.textContent();
    await tab.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoom).not.toHaveText(before ?? "");
    await tab.getByRole("button", { name: "Fit page" }).click();
    await expect(tab.getByRole("button", { name: "Fit page" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await pages.focus();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(tab.getByRole("button", { name: "Fit to width" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Find: Mod+F, the count, Enter moves to the match's page.
    await page.keyboard.press("ControlOrMeta+f");
    const find = tab.getByRole("searchbox", { name: "Find in document" });
    await expect(find).toBeFocused();
    await find.fill("beta");
    const status = tab.getByRole("search").getByRole("status");
    await expect(status).toHaveText("1 of 1");
    await expect(tab.getByRole("textbox", { name: "Page number" })).toHaveValue("2");
    await find.press("Escape");
    await expect(tab.getByRole("search")).toHaveCount(0);

    // Selecting the text layer selects the PDF's words.
    const second = tab.getByRole("group", { name: "Page 2 of 3" });
    await second.locator(".textLayer span").first().dblclick();
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toMatch(/Beta/);

    // A broken file: a clear message, and Download.
    await row("broken.pdf").click();
    const broken = page.getByRole("tabpanel").filter({ hasText: "could not be read as a PDF" });
    await expect(broken.getByRole("button", { name: "Download", exact: true })).toBeVisible();
    expect(violations).toEqual([]);
  } finally {
    expect(await workspace(page, "delete", dir)).toBe(204);
  }
});
