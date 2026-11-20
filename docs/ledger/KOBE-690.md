# KOBE-690: Artifact and workspace HTML frames: block WebRTC, child frames and top-level loads

- **Status:** in review (group 49, branch `group-49-sec-app`)
- **Branch / worktree:** `group-49-sec-app` in `../Kobe-g49`
- **Depends on:** KOBE-437 (the app frame decision this applies)

## Plan

Bring the artifact and workspace frame routes in line with the MCP App frames: CSP directives,
the WebRTC guard script, and iframe-only loads.

## Decisions

- `FRAME_HEADERS` (shared by the artifact, workspace and notebook output frames) adds
  `frame-src 'none'; child-src 'none'; worker-src 'none'; webrtc 'block'`. With `default-src
'none'` the first three were already in force by fallback; they are now explicit.
- New `artifacts/frame-document.ts`: `artifactFrameDocument` / `workspaceFrameDocument` put the
  existing `WEBRTC_GUARD` after the doctype (the app frames' `withWebRtcGuard`); `mayLoadFrame`
  is the app frames' `mayLoadAppFrame` (iframe destination required when the browser sends it).
- Workspace HTML is decoded as UTF-8 to insert the guard (the response already declares UTF-8).
- Top-level uses checked: the web only puts these URLs in iframe `src` (`artifactFrameUrl`,
  `workspaceFrameUrl`). Downloads use `/versions/:n/content` (attachment) and the workspace
  download route, which are unchanged; a test asserts the artifact download still answers a
  top-level load.

## Docs

`docs/guide/for-agents/concepts.md` (Artifact: what the frame allows, so agents inline data) and
`docs/guide/glossary.md` (Artifact: locked-down frame, shown only inside Kobe, download to keep).

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/artifacts/frame-document.test.ts` (FRAME_HEADERS CSP); exact header
  in `artifacts.db.test.ts`.
- ac-2: `frame-document.test.ts` (html, svg, workspace); `artifacts.db.test.ts`,
  `workspace-frame.db.test.ts` (served body starts with the guard).
- ac-3: `frame-document.test.ts` (`mayLoadFrame`); both DB tests refuse `Sec-Fetch-Dest: document`
  with 403 and the artifact download still answers 200 as an attachment.
- ac-4: `e2e/browser/tests/artifact-frame.spec.ts` (workspace and artifact frame: no
  RTCPeerConnection / RTCDataChannel, top-level load 403, download works). Not run here (needs
  a deployment); runs with the next gate1 browser pass.
- ac-5: guide updated (above).
