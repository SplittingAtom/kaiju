import { type BuildInfo, formatBuildDate } from "../../lib/build/build-info";

/**
 * The running build beside the guide's title (KOBE-837), as plain text so screen readers and
 * copy-paste get it: `Version 1.4.0 · Build 1e6fff80abcd · 2026-11-24 14:03 UTC`, without the
 * version when none is set, or `Development build` when the image carries no valid build facts.
 * The values were validated by `buildInfoFrom`; React escapes them either way.
 */
export function BuildLine({
  build,
  className = "",
}: {
  readonly build: BuildInfo;
  readonly className?: string;
}) {
  const classes = `text-muted-foreground text-xs font-normal tracking-normal ${className}`.trim();
  if (build.kind === "development") {
    return (
      <p data-kaiju-build="development" className={classes}>
        Development build
      </p>
    );
  }
  return (
    <p data-kaiju-build={build.sha} className={classes}>
      {build.version !== null && <>Version {build.version} · </>}
      Build <span className="font-mono">{build.sha}</span> ·{" "}
      <time dateTime={build.date}>{formatBuildDate(build.date)}</time>
    </p>
  );
}
