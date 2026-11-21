import { mayLoadAppFrame, withWebRtcGuard } from "../connectors/app-frame.js";
import { svgDocument } from "./serve.js";

/**
 * The documents of the artifact and workspace frames (KOBE-690, applying the KOBE-437 decision of
 * the MCP App frames): agent-written HTML starts with the WebRTC guard, for browsers that ignore
 * the CSP's `webrtc 'block'`, and loads only as an iframe of Kobe's own page.
 */

/** An html artifact, or an svg wrapped in a document, with the WebRTC guard first. */
export function artifactFrameDocument(kind: "html" | "svg", text: string): string {
  return withWebRtcGuard(kind === "svg" ? svgDocument(text) : text);
}

/** A workspace HTML file (read as UTF-8, as its content-type says) with the guard first. */
export function workspaceFrameDocument(bytes: Buffer): string {
  return withWebRtcGuard(bytes.toString("utf8"));
}

/**
 * Whether a request may load an artifact or workspace frame: from Kobe's own page and, when the
 * browser says what it loads, only as an iframe. A top-level copy would leave the page's
 * `frame-src` and could navigate itself anywhere; downloads use the attachment routes instead.
 */
export const mayLoadFrame = mayLoadAppFrame;
