import { describe, expect, it } from "vitest";
import { OTHER_TEAM, SETTINGS, TEAM, USER, must } from "../testing/sandbox-fixtures.js";
import type { SandboxSettings } from "./config.js";
import {
  BOOTSTRAP_TOKEN_AUDIENCE,
  LABEL_MANAGED_BY,
  LABEL_TEAM_ID,
  LABEL_TEAM_NAMESPACE,
  sandboxNames,
} from "./constants.js";
import type { TokenReviewResult } from "./kube.js";
import {
  ADMISSION_PROBE_NAMESPACE,
  SandboxAuthError,
  SandboxProvisioningError,
} from "./provider.js";
import { teamOfNamespace } from "./team-reconcile.js";
import { objectAt, setup } from "../testing/provider-setup.js";

/**
 * KOBE-751: one team namespace prefix per install. An install created before the rename keeps
 * `kobe-team-*` and the `kobe-*` objects in it (nothing recreated); a fresh install gets
 * `kaiju-team-*` and `kaiju-*`; the server never touches a namespace under the other prefix.
 */

const KEPT: SandboxSettings = { ...SETTINGS, teamNamespacePrefix: "kobe-team-" };
const OLD = sandboxNames("kobe-team-");
const NEW = sandboxNames("kaiju-team-");
const OLD_NS = "kobe-team-finance";

/** Every object the provider wrote (not the admission self-check's dry run), kind/namespace/name. */
const written = (kube: ReturnType<typeof setup>["kube"]) =>
  kube.calls
    .filter((c) => c.verb === "apply" || c.verb === "create")
    .filter((c) => c.name !== ADMISSION_PROBE_NAMESPACE)
    .map((c) => `${c.kind}/${c.namespace ?? ""}/${c.name}`);

describe("an upgraded install keeps kobe-team-* (ac-1)", () => {
  it("converges the existing namespace under the kept names and recreates nothing", async () => {
    const { kube, provider } = setup({ settings: KEPT });
    kube.admissionPrefix = "kobe-team-";
    // What the install already has: the team namespace, the member's claim and its volume.
    kube.seed({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: OLD_NS,
        labels: { [LABEL_TEAM_NAMESPACE]: "true", [LABEL_TEAM_ID]: TEAM.id },
      },
    });
    const first = await provider.ensureSandbox(TEAM, USER);
    const pvc = kube.seed({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: `workspace-${first.claimName}`, namespace: OLD_NS },
    });
    kube.calls.length = 0;

    const again = await provider.ensureSandbox(TEAM, USER);
    expect(again.sandboxId).toBe(first.sandboxId);
    expect(objectAt(kube, "PersistentVolumeClaim", pvc.metadata.name, OLD_NS)?.metadata.uid).toBe(
      pvc.metadata.uid,
    );
    expect(kube.calls.filter((c) => c.verb === "delete")).toEqual([]);
  });

  it("writes only kobe-* names into kobe-team-*, never a kaiju-* object or namespace", async () => {
    const { kube, provider } = setup({ settings: KEPT });
    kube.admissionPrefix = "kobe-team-";
    await provider.ensureSandbox(TEAM, USER);
    const names = written(kube);
    expect(names).toEqual(
      expect.arrayContaining([
        `Namespace//${OLD_NS}`,
        `RoleBinding/${OLD_NS}/${OLD.serverRoleBinding}`,
        `NetworkPolicy/${OLD_NS}/${OLD.networkPolicy}`,
        `NetworkPolicy/${OLD_NS}/${OLD.evalNetworkPolicy}`,
        `NetworkPolicy/${OLD_NS}/${OLD.skillScanNetworkPolicy}`,
        `ResourceQuota/${OLD_NS}/${OLD.resourceQuota}`,
        `ResourceQuota/${OLD_NS}/${OLD.evalResourceQuota}`,
        `ResourceQuota/${OLD_NS}/${OLD.memberResourceQuota}`,
        `LimitRange/${OLD_NS}/${OLD.limitRange}`,
        `ServiceAccount/${OLD_NS}/${OLD.serviceAccount}`,
        `SandboxTemplate/${OLD_NS}/${OLD.template}`,
        `SandboxWarmPool/${OLD_NS}/${OLD.warmPool}`,
        `SandboxTemplate/${OLD_NS}/${OLD.evalTemplate}`,
        `SandboxWarmPool/${OLD_NS}/${OLD.evalWarmPool}`,
      ]),
    );
    expect(names.join(" ")).not.toMatch(/kaiju-/);
    for (const o of kube.all().filter((x) => x.metadata.namespace === OLD_NS)) {
      if (o.metadata.labels?.[LABEL_MANAGED_BY]) {
        expect(o.metadata.labels[LABEL_MANAGED_BY]).toBe("kobe-server");
      }
    }
    const template = must(objectAt(kube, "SandboxTemplate", OLD.template, OLD_NS));
    const pod = (
      template.spec as {
        podTemplate: {
          metadata: { labels: Record<string, string> };
          spec: Record<string, unknown>;
        };
      }
    ).podTemplate;
    expect(pod.spec.serviceAccountName).toBe("kobe-sandbox");
    expect(pod.metadata.labels["app.kubernetes.io/name"]).toBe("kobe-sandbox");
    expect(JSON.stringify(pod.spec)).toContain('"name":"kobe-bootstrap"');
  });

  it("refuses to start sandboxes on an upgraded install configured with the new prefix", async () => {
    const { kube, provider } = setup();
    kube.seed({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: OLD_NS,
        labels: { [LABEL_TEAM_NAMESPACE]: "true", [LABEL_TEAM_ID]: TEAM.id },
      },
    });
    const err = await provider.ensureSandbox(TEAM, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxProvisioningError);
    expect((err as Error).message).toMatch(
      /Set the Helm value sandbox\.teamNamespacePrefix to "kobe-team-"/,
    );
    // Nothing was created next to the old namespaces.
    expect(kube.all("Namespace").map((n) => n.metadata.name)).toEqual([OLD_NS]);
    expect(written(kube)).toEqual([]);
  });
});

describe("a fresh install creates kaiju-team-* (ac-1)", () => {
  it("names the namespace and every object in it kaiju-*", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    const names = written(kube);
    expect(names).toContain("Namespace//kaiju-team-finance");
    expect(names).toContain(`SandboxTemplate/kaiju-team-finance/${NEW.template}`);
    expect(names.join(" ")).not.toMatch(/kobe-/);
  });
});

describe("one prefix in force (ac-3)", () => {
  it("refuses to provision when the admission policy pins another prefix than the server", async () => {
    const { kube, provider } = setup();
    kube.admissionPrefix = "kobe-team-";
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(
      /admission policy confines the server to kobe-team-\* namespaces, but the server is configured for kaiju-team-\*/,
    );
    expect(kube.all("Namespace")).toEqual([]);
  });

  it("never converges a namespace under the other prefix", () => {
    const ns = (name: string) => ({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name, labels: { [LABEL_TEAM_ID]: OTHER_TEAM.id } },
    });
    expect(teamOfNamespace(ns("kobe-team-marketing"), NEW)).toBeUndefined();
    expect(teamOfNamespace(ns("kaiju-team-marketing"), OLD)).toBeUndefined();
    expect(teamOfNamespace(ns("kobe-team-marketing"), OLD)).toEqual(OTHER_TEAM);
  });

  it("accepts bootstrap tokens only from the configured prefix's sandbox ServiceAccount", async () => {
    const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
    const { kube, provider } = setup({ settings: KEPT });
    kube.admissionPrefix = "kobe-team-";
    const handle = await provider.ensureSandbox(TEAM, USER);
    const pod = must(objectAt(kube, "Pod", must(handle.podName), OLD_NS));
    const review = (username: string): TokenReviewResult => ({
      authenticated: true,
      audiences: [BOOTSTRAP_TOKEN_AUDIENCE],
      username,
      extra: {
        "authentication.kubernetes.io/pod-name": [pod.metadata.name],
        "authentication.kubernetes.io/pod-uid": [pod.metadata.uid as string],
      },
    });
    kube.tokens.set(TOKEN, review(`system:serviceaccount:${OLD_NS}:kobe-sandbox`));
    await expect(provider.identifyBootstrapToken(TOKEN)).resolves.toMatchObject({
      state: "assigned",
      namespace: OLD_NS,
    });
    for (const username of [
      "system:serviceaccount:kaiju-team-finance:kaiju-sandbox",
      "system:serviceaccount:kaiju-team-finance:kobe-sandbox",
      `system:serviceaccount:${OLD_NS}:kaiju-sandbox`,
    ]) {
      kube.tokens.set(TOKEN, review(username));
      await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(SandboxAuthError);
    }
  });
});
