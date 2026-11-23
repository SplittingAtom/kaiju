/**
 * Which Gitea and Forgejo versions the adapter accepts (spec workspace-git G7, GQ7; KOBE-759).
 *
 * Rule (Chris, 2026-11-22): the release line current at build time and one major back, plus
 * always the vendor's current long-term-support release; anything older is refused. So each
 * minimum is the older of "previous major .0" and "current LTS .0". Revisit at every release of
 * either product (sources and dates in docs/ledger/KOBE-759.md).
 *
 * As of 2026-11-22:
 * - Gitea: current 1.27 (Gitea numbers its majors 1.x), previous 1.26; Gitea has no LTS line.
 *   Minimum 1.26.0.
 * - Forgejo: current 17.0, previous 16.0, current LTS 15.0 (supported until 2027-07-15).
 *   Minimum 15.0.0.
 *
 * Every API call and token-scope behaviour the adapter uses exists in both (scoped tokens since
 * Gitea 1.20; Forgejo 15 is on the Gitea 1.22 API).
 */
export const GITEA_MINIMUM = { major: 1, minor: 26, patch: 0 } as const;
export const FORGEJO_MINIMUM = { major: 15, minor: 0, patch: 0 } as const;

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
