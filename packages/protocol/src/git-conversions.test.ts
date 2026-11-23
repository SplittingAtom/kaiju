import { describe, expect, it } from "vitest";
import {
  gitConversionRefusalSchema,
  gitConversionStartBodySchema,
  gitConversionViewSchema,
} from "./git-conversions.js";

/** KOBE-765: the Convert to repo contract. */
const view = {
  id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  status: "failed",
  step: "push",
  connection_id: null,
  provider: "forgejo",
  base_url: "https://git.example.test",
  organization: "acme",
  repository_name: "docs",
  full_name: "acme/docs",
  visibility: "private",
  carry_history: true,
  use_existing: false,
  default_branch: "main",
  repository_created: true,
  commits_total: 3,
  commits_pushed: 1,
  head_sha: "a".repeat(40),
  error: { code: "host_unreachable", message: "The git host could not be reached.", detail: null },
  attempts: 1,
  requested_by: "33333333-3333-4333-8333-333333333333",
  created_at: "2026-11-22T10:00:00.000Z",
  updated_at: "2026-11-22T10:01:00.000Z",
  finished_at: null,
};

describe("git conversions contract", () => {
  it("decodes an attempt and refuses unknown failures", () => {
    expect(gitConversionViewSchema.parse(view)).toEqual(view);
    expect(
      gitConversionViewSchema.safeParse({ ...view, error: { ...view.error, code: "oops" } })
        .success,
    ).toBe(false);
  });
  it("never asks for a public repository and needs a connection", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(gitConversionStartBodySchema.safeParse({ connection_id: id }).success).toBe(true);
    expect(
      gitConversionStartBodySchema.safeParse({ connection_id: id, visibility: "public" }).success,
    ).toBe(false);
    expect(gitConversionStartBodySchema.safeParse({}).success).toBe(false);
    expect(
      gitConversionStartBodySchema.safeParse({ connection_id: id, repository_name: "a/b" }).success,
    ).toBe(false);
  });
  it("a refusal names its code", () => {
    expect(
      gitConversionRefusalSchema.parse({
        code: "file_rejected_by_host",
        message: "x",
        path: ".git/config",
      }).path,
    ).toBe(".git/config");
  });
});
