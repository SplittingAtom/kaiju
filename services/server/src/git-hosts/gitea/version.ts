/**
 * Which Gitea and Forgejo versions the adapter accepts (spec workspace-git G7, GQ7; KOBE-759).
 * Each minimum is the oldest release that has every API call and token-scope behaviour the
 * adapter uses; the evidence and what is assumed are in docs/ledger/KOBE-759.md. Raise a minimum
 * only when the adapter starts to use something newer.
 *
 * - Gitea 1.20.0: the token scope model the adapter and the console rely on (`read:user`,
 *   `read:organization`, `write:organization`, `write:repository`, `write:issue`, and the 403 that
 *   names the missing one) arrived with the scoped-token redesign (go-gitea PR #24767, 2023).
 *   Every endpoint used is older (org permissions, PR #17232, 2021).
 * - Forgejo 7.0.0: the first release that identifies itself in `/api/v1/version`
 *   (`7.0.0+gitea-1.22.0`), on Gitea 1.22's API, so it has everything above. It includes the
 *   current Forgejo LTS. Forgejo 1.20/1.21 (before 7.0) report a Gitea-style version, so they are
 *   judged as Gitea of the same API level.
 */
export const GITEA_MINIMUM = { major: 1, minor: 20, patch: 0 } as const;
export const FORGEJO_MINIMUM = { major: 7, minor: 0, patch: 0 } as const;

export type GiteaProduct = "gitea" | "forgejo";

export interface VersionVerdict {
  readonly product: GiteaProduct;
  /** The reported version, reduced to safe characters. */
  readonly version: string;
  readonly supported: boolean;
  readonly minimumVersion: string;
}

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

function compare(a: Triple, b: Triple): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

const show = (t: Triple) => `${t.major}.${t.minor}.${t.patch}`;

/**
 * Judges `/api/v1/version`'s value. Forgejo reports its own version with the Gitea API level it
 * is compatible with (`15.0.3+gitea-1.22.0`); Gitea reports `1.27.2` (dev builds `1.27.0+dev-…`).
 * Undefined when the value is not a version.
 */
export function judgeVersion(raw: string): VersionVerdict | undefined {
  const m = VERSION.exec(raw.trim());
  if (!m) return undefined;
  const parsed = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? "0") };
  const product: GiteaProduct = /\+gitea-/i.test(raw) ? "forgejo" : "gitea";
  const minimum = product === "forgejo" ? FORGEJO_MINIMUM : GITEA_MINIMUM;
  return {
    product,
    version: displayVersion(raw),
    supported: compare(parsed, minimum) >= 0,
    minimumVersion: show(minimum),
  };
}
