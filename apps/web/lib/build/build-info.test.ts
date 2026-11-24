import { describe, expect, it } from "vitest";
import { buildInfoFrom, DEVELOPMENT_BUILD, formatBuildDate } from "./build-info";

/** KOBE-837: the running image's build, from KAIJU_BUILD_SHA / _DATE / _VERSION. */
const SHA = "1e6fff80abcd0123456789abcdef0123456789ab";

describe("buildInfoFrom", () => {
  it("reads the short commit, the date in UTC and the version", () => {
    expect(
      buildInfoFrom({
        KAIJU_BUILD_SHA: SHA,
        KAIJU_BUILD_DATE: "2026-11-24T15:03:09+01:00",
        KAIJU_BUILD_VERSION: "v1.4.0",
      }),
    ).toEqual({
      kind: "image",
      sha: "1e6fff80abcd",
      date: "2026-11-24T14:03:09.000Z",
      version: "1.4.0",
    });
  });

  it("lower-cases the sha and leaves the version out when none is set", () => {
    expect(
      buildInfoFrom({ KAIJU_BUILD_SHA: SHA.toUpperCase(), KAIJU_BUILD_DATE: "2026-11-24T14:03Z" }),
    ).toEqual({
      kind: "image",
      sha: "1e6fff80abcd",
      date: "2026-11-24T14:03:00.000Z",
      version: null,
    });
  });

  it("is a development build when the sha or the date is missing or blank", () => {
    expect(buildInfoFrom({})).toBe(DEVELOPMENT_BUILD);
    expect(buildInfoFrom({ KAIJU_BUILD_SHA: SHA })).toBe(DEVELOPMENT_BUILD);
    expect(buildInfoFrom({ KAIJU_BUILD_DATE: "2026-11-24T14:03:09Z" })).toBe(DEVELOPMENT_BUILD);
    expect(buildInfoFrom({ KAIJU_BUILD_SHA: " ", KAIJU_BUILD_DATE: " " })).toBe(DEVELOPMENT_BUILD);
  });

  it.each([
    ["<script>alert(1)</script>", "2026-11-24T14:03:09Z"],
    ["local-1e6fff80abcd", "2026-11-24T14:03:09Z"],
    ["abc", "2026-11-24T14:03:09Z"],
    [SHA, "yesterday"],
    [SHA, "2026-11-24"],
    [SHA, "2026-11-24T14:03:09"],
    [SHA, "2026-13-45T99:03:09Z"],
    [SHA, "2026-11-24T14:03:09Z<b>"],
  ])("rejects garbage (sha %j, date %j)", (sha, date) => {
    expect(buildInfoFrom({ KAIJU_BUILD_SHA: sha, KAIJU_BUILD_DATE: date })).toBe(DEVELOPMENT_BUILD);
  });

  it("drops a malformed version but keeps the build", () => {
    const build = buildInfoFrom({
      KAIJU_BUILD_SHA: SHA,
      KAIJU_BUILD_DATE: "2026-11-24T14:03:09Z",
      KAIJU_BUILD_VERSION: "<img src=x>",
    });
    expect(build).toMatchObject({ kind: "image", version: null });
  });
});

describe("formatBuildDate", () => {
  it("prints the UTC time to the minute", () => {
    expect(formatBuildDate("2026-11-24T14:03:09.000Z")).toBe("2026-11-24 14:03 UTC");
  });
});
