/**
 * The running web image's build (KOBE-837), shown beside the guide's title so a member can tell
 * which version is serving. The image sets `KAIJU_BUILD_SHA` (the commit), `KAIJU_BUILD_DATE`
 * (ISO 8601) and optionally `KAIJU_BUILD_VERSION` (a release) as runtime ENV from build args
 * (apps/web/Dockerfile). They are read on the server per request, never inlined into the bundle,
 * so the page always names the image it runs in. Every value is checked against its shape: a
 * missing or malformed sha or date means a development build; a malformed version is left out.
 */

/** Length of the short commit shown as the build number. */
export const BUILD_SHA_LENGTH = 12;

const SHA = /^[0-9a-f]{7,40}$/i;
/** ISO 8601 date and time with an explicit offset (`Z` or `±hh:mm`), as `git log --format=%cI` prints. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const VERSION = /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,40})?$/;

export type BuildInfo =
  | { readonly kind: "development" }
  | {
      readonly kind: "image";
      /** The short commit, lower case, {@link BUILD_SHA_LENGTH} characters (or fewer if given so). */
      readonly sha: string;
      /** The build time in UTC, ISO 8601 (`toISOString`). */
      readonly date: string;
      /** The release version without a leading `v`, or null when none was set. */
      readonly version: string | null;
    };

export const DEVELOPMENT_BUILD: BuildInfo = { kind: "development" };

/** The build described by `env`, or a development build when its sha or date is missing or invalid. */
export function buildInfoFrom(env: Readonly<Record<string, string | undefined>>): BuildInfo {
  const sha = env.KAIJU_BUILD_SHA?.trim() ?? "";
  const date = env.KAIJU_BUILD_DATE?.trim() ?? "";
  if (!SHA.test(sha) || !ISO_DATE.test(date)) return DEVELOPMENT_BUILD;
  const time = Date.parse(date);
  if (!Number.isFinite(time)) return DEVELOPMENT_BUILD;
  const version = env.KAIJU_BUILD_VERSION?.trim() ?? "";
  return {
    kind: "image",
    sha: sha.toLowerCase().slice(0, BUILD_SHA_LENGTH),
    date: new Date(time).toISOString(),
    version: VERSION.test(version) ? version.replace(/^v/, "") : null,
  };
}

/** This process's build, from its environment (server only: call it from a server component). */
export function currentBuildInfo(): BuildInfo {
  return buildInfoFrom(process.env);
}

/** `2026-11-24 14:03 UTC`: the build time to the minute, in UTC. */
export function formatBuildDate(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
