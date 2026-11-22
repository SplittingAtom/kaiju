import type { IsolationGate } from "../isolation/gate.js";
import type { SandboxSettings } from "../sandbox/config.js";
import { createSandboxProvider, type SandboxProviderOptions } from "../sandbox/provider.js";
import { createFakeKube, simulateAgentSandbox, type FakeKube } from "./fake-kube.js";
import { SETTINGS, gateFor, seedCluster } from "./sandbox-fixtures.js";

/**
 * The sandbox provider's unit-test setup, shared by the `sandbox/provider-*.test.ts` files (split
 * out of provider.test.ts by KOBE-710): a fake cluster with the agent-sandbox controllers, the
 * provider over it, and a few cluster helpers.
 */

export const NS = "kobe-team-finance";

export function setup(
  opts: {
    controller?: Parameters<typeof simulateAgentSandbox>[1] | false;
    settings?: SandboxSettings;
    gate?: Pick<IsolationGate, "require">;
    provider?: Partial<SandboxProviderOptions>;
  } = {},
) {
  const kube = createFakeKube();
  seedCluster(kube);
  if (opts.controller !== false) simulateAgentSandbox(kube, opts.controller || {});
  const gate = opts.gate ?? gateFor(kube);
  const provider = createSandboxProvider({
    kube,
    isolation: gate,
    settings: opts.settings ?? SETTINGS,
    sleep: async () => {},
    ...opts.provider,
  });
  return { kube, gate, provider };
}

export const objectAt = (kube: FakeKube, kind: string, name: string, namespace?: string) =>
  kube.all(kind).find((o) => o.metadata.name === name && o.metadata.namespace === namespace);

export const recreateRuntimeClass = (kube: FakeKube, handler = "runsc") =>
  kube.seed({
    apiVersion: "node.k8s.io/v1",
    kind: "RuntimeClass",
    metadata: {
      name: "gvisor",
      uid: crypto.randomUUID(),
      creationTimestamp: "2030-01-01T00:00:00Z",
    },
    handler,
  });
