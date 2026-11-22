import type { GitHostProbe } from "../provider.js";

/**
 * Supported Gitea and Forgejo versions (GQ7: current at build time and one major back; KOBE-759).
 * Checked 2026-11-22: Gitea's current release line is 1.27 (Gitea numbers its major releases
 * 1.x), Forgejo's is 17.0 (October 2026). Raise both when a new line is tested.
 */
export const GITEA_MINIMUM = { major: 1, minor: 26, patch: 0 } as const;
export const GITEA_NEWEST_TESTED = { major: 1, minor: 27 } as const;
export const FORGEJO_MINIMUM = { major: 16, minor: 0, patch: 0 } as const;
export const FORGEJO_NEWEST_TESTED = { major: 17, minor: 0 } as const;

interface Triple {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION = /^v?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,6}))?/;

/** A host's version string reduced to safe characters, for messages. */
export function displayVersion(raw: string): string {
  return raw.replace(/[^0-9A-Za-z.+_-]/g, "").slice(0, 64) || "unknown";
}

function parse(raw: string): Triple | undefined {
  const m = VERSION.exec(raw.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? "0") };
}

function compare(a: Triple, b: Triple): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

const show = (t: Triple) => `${t.major}.${t.minor}.${t.patch}`;

/**
 * Reads `/api/v1/version`'s value. Forgejo reports its own version with the Gitea API level it
 * is compatible with (`17.0.1+gitea-1.22.0`); Gitea reports `1.27.2` (dev builds `1.27.0+dev-…`).
 * Returns undefined when the value is not a version at all.
 */
export function judgeVersion(raw: string): GitHostProbe | undefined {
  const version = displayVersion(raw);
  const product = /\+gitea-/i.test(raw) ? "forgejo" : "gitea";
  const parsed = parse(raw);
  if (!parsed) return undefined;
  const minimum = product === "forgejo" ? FORGEJO_MINIMUM : GITEA_MINIMUM;
  const newest = product === "forgejo" ? FORGEJO_NEWEST_TESTED : GITEA_NEWEST_TESTED;
  return {
    product,
    version,
    supported: compare(parsed, minimum) >= 0,
    minimumVersion: show(minimum),
    newerThanTested: compare(parsed, { ...newest, patch: Number.MAX_SAFE_INTEGER }) > 0,
  };
}
