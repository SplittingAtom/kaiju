import type { Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";
import { deleteWorkspacePath, pageApi, toolTurn, workspaceFile } from "./support/gate5.js";

/**
 * KOBE-690 ac-4 (applying the KOBE-437 decision to artifact and workspace frames): agent-written
 * HTML in an artifact frame and a workspace HTML frame finds no RTCPeerConnection (the route puts
 * the WebRTC guard first and the CSP carries `webrtc 'block'`), and neither frame URL opens as a
 * top-level page. The artifact's download route still answers a top-level load, as an attachment.
 * One short model turn (create_artifact never asks).
 */
const PROBE = "kobe-690-probe";
const PROBE_HTML =
  "<!doctype html><html><body><p>probe</p><script>" +
  `parent.postMessage({probe:${JSON.stringify(PROBE)},rtc:typeof window.RTCPeerConnection,` +
  "dc:typeof window.RTCDataChannel},'*')</script></body></html>";

/** What the probe posts: its marker (the script ran in the frame) and the WebRTC globals it saw. */
interface Report {
  readonly probe: string;
  readonly rtc: string;
  readonly dc: string;
}

/** WebRTC blocked, from a probe that ran: the same check for both frames. */
const BLOCKED: Report = { probe: PROBE, rtc: "undefined", dc: "undefined" };

/** Loads `src` in an iframe of Kobe's page (as the panel does) and waits for the probe. */
async function probeFrame(page: Page, src: string): Promise<Report> {
  return (await page.evaluate(
    ({ src, probe }) =>
      new Promise<unknown>((resolve, reject) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts allow-forms");
        frame.style.cssText = "position:fixed;right:0;bottom:0;width:200px;height:120px";
        const timer = setTimeout(() => reject(new Error("the probe never reported")), 30_000);
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow) return;
          if ((event.data as { probe?: string })?.probe !== probe) return;
          clearTimeout(timer);
          frame.remove();
          resolve(event.data);
        });
        frame.src = src;
        document.body.appendChild(frame);
      }),
    { src, probe: PROBE },
  )) as Report;
}

/** A top-level navigation to `path` in a new tab of the same session; returns the status. */
async function topLevelStatus(page: Page, path: string): Promise<number> {
  const tab = await page.context().newPage();
  try {
    const download = tab.waitForEvent("download", { timeout: 5_000 }).catch(() => null);
    const res = await tab.goto(path).catch(() => null);
    if (res) return res.status();
    // An attachment starts a download instead of a page.
    return (await download) ? 200 : 0;
  } finally {
    await tab.close();
  }
}

test("artifact and workspace HTML frames: no WebRTC, no top-level load (KOBE-690)", async ({
  chat,
  page,
}) => {
  const stem = `kobe-690-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await chat.open();
  const team = await page.evaluate(() => window.localStorage.getItem("kobe.lastTeamId"));
  expect(team).toBeTruthy();

  // The workspace HTML frame: no model turn needed.
  const file = `${stem}.html`;
  expect(await workspaceFile(page, file, PROBE_HTML)).toBeLessThan(300);
  try {
    const src = `/v1/workspace/frame?${new URLSearchParams({ path: file, team: team ?? "" })}`;
    expect(await probeFrame(page, src)).toEqual(BLOCKED);
    expect(await topLevelStatus(page, src)).toBe(403);
  } finally {
    await deleteWorkspacePath(page, file);
  }

  // The artifact frame.
  await chat.send(toolTurn("create_artifact", { kind: "html", title: stem, content: PROBE_HTML }));
  const threadId = await chat.threadId();
  await chat.waitForIdle();
  const listed = await pageApi<{ artifacts?: { id: string; title: string }[] }>(
    page,
    "GET",
    `/v1/artifacts?thread_id=${threadId}`,
  );
  const artifact = (listed.json.artifacts ?? []).find((a) => a.title === stem);
  expect(artifact, "the agent created the html artifact").toBeDefined();
  const base = `/v1/artifacts/${artifact?.id ?? ""}/versions/1`;
  const src = `${base}/frame?team=${team ?? ""}`;
  expect(await probeFrame(page, src)).toEqual(BLOCKED);
  expect(await topLevelStatus(page, src)).toBe(403);
  // Downloads still work top-level (an attachment).
  expect(await topLevelStatus(page, `${base}/content?team=${team ?? ""}`)).toBe(200);
});
