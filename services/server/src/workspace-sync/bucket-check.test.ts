import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  bucketLifecycleWarning,
  expiresNoncurrentVersions,
  type BucketCheckSend,
} from "./bucket-check.js";

const named = (name: string) => Object.assign(new Error(name), { name });

/** A store answering versioning with `status` and lifecycle with `rules` (or an error). */
function store(
  status: string | undefined | Error,
  rules: LifecycleRule[] | Error,
): BucketCheckSend {
  return (command) => {
    if (command instanceof GetBucketVersioningCommand) {
      return status instanceof Error ? Promise.reject(status) : Promise.resolve({ Status: status });
    }
    if (command instanceof GetBucketLifecycleConfigurationCommand) {
      return rules instanceof Error ? Promise.reject(rules) : Promise.resolve({ Rules: rules });
    }
    return Promise.reject(new Error("unexpected command"));
  };
}

const expiry = (extra: Partial<LifecycleRule> = {}): LifecycleRule => ({
  ID: "noncurrent",
  Status: "Enabled",
  Filter: { Prefix: "" },
  NoncurrentVersionExpiration: { NoncurrentDays: 30 },
  ...extra,
});

describe("bucketLifecycleWarning (KOBE-738)", () => {
  it("warns when versioning is on and nothing expires noncurrent versions", async () => {
    expect(await bucketLifecycleWarning(store("Enabled", []), "b", "")).toMatch(
      /versioning is enabled.*noncurrent/,
    );
    expect(
      await bucketLifecycleWarning(
        store("Enabled", named("NoSuchLifecycleConfiguration")),
        "b",
        "",
      ),
    ).toMatch(/NoncurrentVersionExpiration/);
    expect(await bucketLifecycleWarning(store("Suspended", []), "b", "")).toMatch(/suspended/);
  });

  it("is quiet without versioning or with an expiry rule covering Kaiju's prefix", async () => {
    expect(await bucketLifecycleWarning(store(undefined, []), "b", "")).toBeUndefined();
    expect(await bucketLifecycleWarning(store("Enabled", [expiry()]), "b", "")).toBeUndefined();
    expect(
      await bucketLifecycleWarning(
        store("Enabled", [expiry({ Filter: { Prefix: "kobe/" } })]),
        "b",
        "kobe/",
      ),
    ).toBeUndefined();
  });

  it("logs a skipped check at debug with the bucket and the error name only", async () => {
    const lines: unknown[] = [];
    const secret = Object.assign(new Error("key AKIA-secret refused"), { name: "AccessDenied" });
    await bucketLifecycleWarning(store("Enabled", secret), "kobe-bucket", "", (f, m) =>
      lines.push([f, m]),
    );
    expect(lines).toEqual([
      [
        { bucket: "kobe-bucket", call: "GetBucketLifecycleConfiguration", error: "AccessDenied" },
        "bucket lifecycle check skipped",
      ],
    ]);
    expect(JSON.stringify(lines)).not.toContain("AKIA");
  });

  it("tolerates stores that do not implement or allow the calls", async () => {
    expect(
      await bucketLifecycleWarning(store(named("NotImplemented"), []), "b", ""),
    ).toBeUndefined();
    expect(
      await bucketLifecycleWarning(store("Enabled", named("AccessDenied")), "b", ""),
    ).toBeUndefined();
  });
});

describe("expiresNoncurrentVersions", () => {
  it("needs an enabled rule with noncurrent days covering every object under the prefix", () => {
    expect(expiresNoncurrentVersions([expiry()], "kobe/")).toBe(true);
    expect(expiresNoncurrentVersions([expiry({ Filter: undefined, Prefix: "" })], "")).toBe(true);
    expect(expiresNoncurrentVersions([expiry({ Status: "Disabled" })], "")).toBe(false);
    expect(
      expiresNoncurrentVersions([expiry({ NoncurrentVersionExpiration: undefined })], ""),
    ).toBe(false);
    expect(expiresNoncurrentVersions([expiry({ Filter: { Prefix: "other/" } })], "kobe/")).toBe(
      false,
    );
    expect(expiresNoncurrentVersions([expiry({ Filter: { Prefix: "kobe/" } })], "")).toBe(false);
    expect(
      expiresNoncurrentVersions([expiry({ Filter: { Tag: { Key: "k", Value: "v" } } })], ""),
    ).toBe(false);
  });
});
