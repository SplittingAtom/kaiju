import { describe, expect, it, vi } from "vitest";
import { createFakeKube, type FakeKube } from "../testing/fake-kube.js";
import { LABEL_TEAM_ID, LABEL_TEAM_NAMESPACE } from "./constants.js";
import { KubeApiError } from "./kube.js";
import {
  TeamNamespacePrefixError,
  assertTeamNamespacePrefix,
  checkTeamNamespacePrefixAtStart,
  foreignTeamNamespaces,
  prefixMismatchMessage,
} from "./namespace-prefix.js";

/** KOBE-751 ac-2: the start-up check on the team namespace prefix, with a clear message. */

const TEAM_ID = "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e";

function namespace(kube: FakeKube, name: string, team = true): void {
  kube.seed({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name,
      labels: team ? { [LABEL_TEAM_NAMESPACE]: "true", [LABEL_TEAM_ID]: TEAM_ID } : {},
    },
  });
}

const log = () => ({ warn: vi.fn(), info: vi.fn() });

describe("team namespace prefix check (KOBE-751)", () => {
  it("passes a fresh install and an install whose namespaces match the configured prefix", async () => {
    const kube = createFakeKube();
    namespace(kube, "kube-system", false);
    await expect(assertTeamNamespacePrefix(kube, "kaiju-team-")).resolves.toBeUndefined();
    namespace(kube, "kobe-team-finance");
    namespace(kube, "kobe-team-sales");
    await expect(assertTeamNamespacePrefix(kube, "kobe-team-")).resolves.toBeUndefined();
  });

  it("refuses an upgraded install configured with the new prefix, naming the value to set", async () => {
    const kube = createFakeKube();
    namespace(kube, "kobe-team-sales");
    namespace(kube, "kobe-team-finance");
    expect(await foreignTeamNamespaces(kube, "kaiju-team-")).toEqual([
      "kobe-team-finance",
      "kobe-team-sales",
    ]);
    const err = await assertTeamNamespacePrefix(kube, "kaiju-team-").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamNamespacePrefixError);
    expect((err as Error).message).toBe(
      'Team namespaces exist under another prefix than the configured sandbox.teamNamespacePrefix "kaiju-team-": kobe-team-finance, kobe-team-sales. ' +
        'Set the Helm value sandbox.teamNamespacePrefix to "kobe-team-" (the prefix the existing team namespaces use) and upgrade again; ' +
        "moving team namespaces to another prefix is not supported.",
    );
  });

  it("refuses the reverse case and a mix of both prefixes", async () => {
    const kube = createFakeKube();
    namespace(kube, "kaiju-team-a");
    await expect(assertTeamNamespacePrefix(kube, "kobe-team-")).rejects.toThrow(
      /sandbox\.teamNamespacePrefix to "kaiju-team-"/,
    );
    namespace(kube, "kobe-team-b");
    await expect(assertTeamNamespacePrefix(kube, "kobe-team-")).rejects.toThrow(
      /sandbox\.teamNamespacePrefix to "kaiju-team-"/,
    );
  });

  it("goes by the team-namespace label: unlabelled namespaces are never counted", async () => {
    const kube = createFakeKube();
    namespace(kube, "kobe-team-old", false);
    namespace(kube, "kaiju-team-a");
    await expect(assertTeamNamespacePrefix(kube, "kaiju-team-")).resolves.toBeUndefined();
  });

  it("explains labelled namespaces under no known prefix, and shortens long lists", () => {
    expect(prefixMismatchMessage("kaiju-team-", ["other-ns"])).toMatch(
      /other-ns\. They are labelled kobe\.splittingatom\.io\/team-namespace=true but are not all under one of the prefixes Kaiju uses \(kaiju-team-, kobe-team-\)/,
    );
    const many = Array.from({ length: 8 }, (_, i) => `kobe-team-t${i}`);
    expect(prefixMismatchMessage("kaiju-team-", many)).toContain(
      "kobe-team-t0, kobe-team-t1, kobe-team-t2, kobe-team-t3, kobe-team-t4 and 3 more.",
    );
  });

  it("stops the start on a mismatch", async () => {
    const kube = createFakeKube();
    namespace(kube, "kobe-team-finance");
    await expect(checkTeamNamespacePrefixAtStart(kube, "kaiju-team-", log())).rejects.toThrow(
      TeamNamespacePrefixError,
    );
  });

  it("starts when the API cannot answer (the provider checks again before provisioning)", async () => {
    const kube = createFakeKube();
    kube.failNext("list", "Namespace", 503);
    const l = log();
    await expect(checkTeamNamespacePrefixAtStart(kube, "kaiju-team-", l)).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(KubeApiError), prefix: "kaiju-team-" }),
      expect.stringContaining("checked before provisioning"),
    );
  });
});
