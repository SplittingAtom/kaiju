import { describe, expect, it } from "vitest";
import { WEBRTC_GUARD } from "../connectors/app-frame.js";
import { FRAME_HEADERS } from "./serve.js";
import { artifactFrameDocument, mayLoadFrame, workspaceFrameDocument } from "./frame-document.js";

/** KOBE-690: artifact and workspace frames get the app frames' WebRTC block (KOBE-437). */
const directives = new Map(
  (FRAME_HEADERS["content-security-policy"] ?? "").split(";").map((d) => {
    const [name = "", ...values] = d.trim().split(/\s+/);
    return [name, values.join(" ")] as const;
  }),
);
const PUBLIC = "https://kobe.example";

describe("FRAME_HEADERS CSP", () => {
  it("blocks WebRTC, child frames and workers, and keeps the opaque sandbox", () => {
    expect(directives.get("webrtc")).toBe("'block'");
    expect(directives.get("frame-src")).toBe("'none'");
    expect(directives.get("child-src")).toBe("'none'");
    expect(directives.get("worker-src")).toBe("'none'");
    expect(directives.get("connect-src")).toBe("'none'");
    expect(directives.get("sandbox")).toBe("allow-scripts allow-forms");
    expect(FRAME_HEADERS["content-security-policy"]).not.toContain("allow-same-origin");
  });
});

describe("artifactFrameDocument", () => {
  it("puts the WebRTC guard first in an html artifact, after its doctype", () => {
    expect(artifactFrameDocument("html", "<!doctype html><p>x</p>")).toBe(
      `<!doctype html>${WEBRTC_GUARD}<p>x</p>`,
    );
    expect(artifactFrameDocument("html", "<p>x</p>")).toBe(`${WEBRTC_GUARD}<p>x</p>`);
  });

  it("wraps an svg in a document that starts with the guard", () => {
    const doc = artifactFrameDocument("svg", "<svg/>");
    expect(doc.startsWith(`<!doctype html>${WEBRTC_GUARD}`)).toBe(true);
    expect(doc).toMatch(/<body><svg\/><\/body><\/html>$/);
  });
});

describe("guard placement (KOBE-690)", () => {
  it("goes first when anything but whitespace precedes the doctype", () => {
    for (const lead of ["<!--> ", "<!-- a --!> ", "<!-- c -->"]) {
      const html = `${lead}<!doctype html><script>x()</script>`;
      expect(artifactFrameDocument("html", html), lead).toBe(`${WEBRTC_GUARD}${html}`);
      expect(workspaceFrameDocument(Buffer.from(html)), lead).toBe(`${WEBRTC_GUARD}${html}`);
    }
  });

  it("wraps an svg holding comments with the guard still first", () => {
    const doc = artifactFrameDocument("svg", "<!--> <svg><script>x()</script></svg>");
    expect(doc.startsWith(`<!doctype html>${WEBRTC_GUARD}`)).toBe(true);
  });
});

describe("workspaceFrameDocument", () => {
  it("puts the guard first in a workspace html file", () => {
    const doc = workspaceFrameDocument(Buffer.from("<!DOCTYPE html>\n<h1>hi</h1>", "utf8"));
    expect(doc).toBe(`<!DOCTYPE html>${WEBRTC_GUARD}\n<h1>hi</h1>`);
  });
});

describe("mayLoadFrame", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("admits an iframe load from Kobe's own page", () => {
    expect(
      mayLoadFrame(h({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe" }), PUBLIC),
    ).toBe(true);
    // No fetch metadata at all (non-browser client): admitted, as the app frames.
    expect(mayLoadFrame(h({}), PUBLIC)).toBe(true);
  });

  it("refuses a top-level navigation and a cross-site one", () => {
    expect(
      mayLoadFrame(h({ "sec-fetch-site": "none", "sec-fetch-dest": "document" }), PUBLIC),
    ).toBe(false);
    expect(
      mayLoadFrame(h({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" }), PUBLIC),
    ).toBe(false);
    expect(
      mayLoadFrame(h({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" }), PUBLIC),
    ).toBe(false);
  });
});
