import type { ObjectRef } from "../kube.js";

/** References and field readers for untyped Kubernetes objects (KOBE-22; split by KOBE-710). */

/** The `/workspace` PVC agent-sandbox creates for a Sandbox (volumeClaimTemplate `workspace`). */
export const workspacePvcName = (sandboxName: string): string => `workspace-${sandboxName}`;

export const POD_NAME_ANNOTATION = "agents.x-k8s.io/pod-name";

export const ref = (
  apiVersion: string,
  kind: string,
  name: string,
  namespace?: string,
): ObjectRef => ({
  apiVersion,
  kind,
  name,
  ...(namespace ? { namespace } : {}),
});
export const CLAIM = (namespace: string, name: string) =>
  ref("extensions.agents.x-k8s.io/v1beta1", "SandboxClaim", name, namespace);
export const SANDBOX = (namespace: string, name: string) =>
  ref("agents.x-k8s.io/v1beta1", "Sandbox", name, namespace);
export const POD = (namespace: string, name: string) => ref("v1", "Pod", name, namespace);
export const PVC = (namespace: string, name: string) =>
  ref("v1", "PersistentVolumeClaim", name, namespace);
export const WORKSPACE_PVC =
  /^workspace-u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads a nested field from an untyped Kubernetes object. */
export function field(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
export const str = (obj: unknown, ...path: string[]): string | undefined => {
  const v = field(obj, ...path);
  return typeof v === "string" && v !== "" ? v : undefined;
};
