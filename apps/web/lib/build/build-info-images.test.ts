import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-837 (ac-2): the web and service images take the build facts as build args and set them as
 * runtime ENV (never NEXT_PUBLIC_ inlining), and publish.yml passes the commit and its date.
 */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

const NAMES = ["KAIJU_BUILD_SHA", "KAIJU_BUILD_DATE", "KAIJU_BUILD_VERSION"] as const;

/** The final (runtime) stage of a multi-stage Dockerfile. */
function runtimeStage(dockerfile: string): string {
  const stages = dockerfile.split(/^FROM /m);
  return stages[stages.length - 1] ?? "";
}

describe.each(["apps/web/Dockerfile", "services/Dockerfile"])("%s", (path) => {
  const runtime = runtimeStage(read(path));

  it.each(NAMES)("declares %s as a build arg and runtime ENV", (name) => {
    expect(runtime).toMatch(new RegExp(`^ARG ${name}=""$`, "m"));
    expect(runtime).toMatch(new RegExp(`^ENV .*\\b${name}=\\$\\{${name}\\}`, "m"));
  });

  it("never inlines them as NEXT_PUBLIC_ variables", () => {
    expect(read(path)).not.toMatch(/NEXT_PUBLIC_KAIJU_BUILD/);
  });
});

describe("publish.yml", () => {
  const workflow = read(".github/workflows/publish.yml");

  it("passes the commit and its date as build args", () => {
    expect(workflow).toContain('echo "KAIJU_BUILD_SHA=${GITHUB_SHA}"');
    expect(workflow).toContain(
      'echo "KAIJU_BUILD_DATE=$(git log -1 --format=%cI "${GITHUB_SHA}")"',
    );
    expect(workflow.match(/\$\{\{ steps\.build-info\.outputs\.args \}\}/g)).toHaveLength(2);
  });

  it("turns them on for web and server", () => {
    expect(workflow).toMatch(/name: web,[^}]*build-info: true/);
    expect(workflow).toMatch(/name: server,[^}]*build-info: true/);
  });
});
