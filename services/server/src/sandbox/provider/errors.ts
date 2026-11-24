/** Errors the sandbox provider throws (KOBE-22; split out of provider.ts by KOBE-710). */

/** A team namespace converged except for these scoped ResourceQuotas (members are unaffected). */
export class TeamQuotaDegradedError extends Error {
  constructor(
    readonly namespace: string,
    readonly quotas: readonly string[],
  ) {
    super(`${namespace}: could not apply ${quotas.join(", ")}`);
    this.name = "TeamQuotaDegradedError";
  }
}

/** A sandbox could not be provisioned (cluster state, conflicts). Operator-facing message. */
export class SandboxProvisioningError extends Error {
  readonly code = "sandbox_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "SandboxProvisioningError";
  }
}

/** Rancher's namespace admission webhooks (`rancher.cattle.io.namespaces*`). */
export const RANCHER_NAMESPACE_WEBHOOK = /rancher\.cattle\.io\.namespaces/;

export function rancherRefusal(namespace: string): string {
  return (
    `Rancher's namespace webhook (rancher.cattle.io.namespaces) refused team namespace ` +
    `${namespace}: on Rancher-managed clusters the server's ServiceAccount needs 'updatepsa' on ` +
    `projects.management.cattle.io to create namespaces with Pod Security labels. Set the chart ` +
    `value rancher.enabled=true (docs/install.md).`
  );
}

/** A bootstrap token did not prove a live Kaiju sandbox pod. Detail is for logs only. */
export class SandboxAuthError extends Error {
  readonly code = "unauthorized";
  constructor(readonly detail: string) {
    super(`sandbox authentication failed: ${detail}`);
    this.name = "SandboxAuthError";
  }
}
