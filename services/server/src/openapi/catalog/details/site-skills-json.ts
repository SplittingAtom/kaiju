import { REGISTRY_PUBLISHERS, REGISTRY_VERSION_STATES } from "@kaiju/protocol";
import { arr, bool, int, nullable, obj, oneOfStrings, str } from "../json.js";

/**
 * JSON shapes shared by the Site skills details (KOBE-771): diffs, raw files, scan results and
 * draft rows the routes build without a zod schema (read from `skills/registry/review-diff.ts`,
 * `skills/site-edit/*.ts` and `@kaiju/skill-scanner`'s `ScanResult`).
 */

/** A JSON object the route passes through as stored (scan, manifest, provenance, scorecard). */
export const storedObject = { type: "object", description: "Passed through as stored." };

export const person = obj({ id: str, name: str });

export const versionState = oneOfStrings(...REGISTRY_VERSION_STATES);
export const publisher = oneOfStrings(...REGISTRY_PUBLISHERS);

/** `FileDiff` (review-diff.ts). */
export const fileDiff = obj({
  path: str,
  status: oneOfStrings("added", "removed", "changed", "unchanged"),
  size: int,
  binary: bool,
  "notUtf8?": { type: "boolean", enum: [true] },
  "notDiffed?": oneOfStrings("too_large", "too_different", "skipped"),
  hunks: arr(obj({ oldStart: int, oldLines: int, newStart: int, newLines: int, lines: arr(str) })),
});

/** `PackageDiff` (review-diff.ts). */
export const packageDiffFields = {
  files: arr(fileDiff),
  changedFiles: int,
  truncated: bool,
} as const;

/** `RawFile` (review-diff.ts): text, escaped text or a hex dump, up to 1 MiB. */
export const rawFile = obj({
  path: str,
  size: int,
  sha256: str,
  encoding: oneOfStrings("text", "escaped", "hex"),
  text: str,
  truncated: bool,
});

const severity = oneOfStrings("caution", "block");

/** `Finding` of `@kaiju/skill-scanner`. */
export const scanFinding = obj({
  category: str,
  file: str,
  line: int,
  excerpt: str,
  rule: str,
  severity,
});

/** The parts of a `ScanResult` the routes send. */
export const scanFields = {
  verdict: oneOfStrings("pass", "caution", "block"),
  findings: arr(scanFinding),
  scripts: arr(str),
  skipped: arr(str),
} as const;

/** `draftJson` (routes/site-skill-catalog-edit/shared.ts). */
export const siteDraftRecord = obj({
  id: str,
  skillId: str,
  baseVersionId: str,
  rev: int,
  sizeBytes: int,
  fileCount: int,
  updatedAt: str,
  updatedBy: str,
});

/** `SiteDraftFile` (skills/site-edit/site-drafts.ts). */
export const siteDraftFile = obj({
  path: str,
  size: int,
  kind: oneOfStrings("text", "binary"),
  updatedAt: str,
});

/** `SiteVersionRow` (skills/site-edit/catalog-view.ts). */
export const siteVersionRow = obj({
  id: str,
  semver: str,
  seq: int,
  publisher,
  state: { type: "string", description: "The review state, or `suspended` during a rescan Block." },
  verdict: oneOfStrings("pass", "caution", "block"),
  approvedAt: nullable(str),
  submittedAt: str,
  submittedBy: nullable(str),
  runtimeHash: str,
  packageHash: str,
  changelog: nullable(str),
  stored: bool,
});
