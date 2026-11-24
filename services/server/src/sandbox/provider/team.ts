import type { VerifiedIsolation } from "../../isolation/gate.js";
import { LABEL_TEAM_ID, LABEL_TEAM_NAMESPACE, POD_SECURITY_LEVEL, namesOf } from "../constants.js";
import {
  evalResourceQuotaManifest,
  evalSandboxTemplateManifest,
  evalWarmPoolManifest,
  memberResourceQuotaManifest,
} from "../eval-manifests.js";
import { KubeApiError, isKubeStatus } from "../kube.js";
import {
  assertTeamRef,
  evalNetworkPolicyManifest,
  limitRangeManifest,
  namespaceManifest,
  networkPolicyManifest,
  pullSecretManifest,
  resourceQuotaManifest,
  sandboxServiceAccountManifest,
  sandboxTemplateManifest,
  serverRoleBindingManifest,
  skillScanNetworkPolicyManifest,
  teamNamespaceName,
  warmPoolManifest,
  type KubeObject,
  type TeamRef,
} from "../manifests.js";
import { logger } from "../../logger.js";
import { TeamNamespacePrefixError, assertTeamNamespacePrefix } from "../namespace-prefix.js";
import { reconcileTeamNamespaces, type TeamReconcileSummary } from "../team-reconcile.js";
import {
  RANCHER_NAMESPACE_WEBHOOK,
  SandboxProvisioningError,
  TeamQuotaDegradedError,
  rancherRefusal,
} from "./errors.js";
import { ref } from "./kube-objects.js";
import type { ProviderContext } from "./context.js";
import type { SandboxProvider } from "./types.js";

/**
 * Team namespaces (spec D11; KOBE-22, KOBE-115): the admission self-check, converging a team's
 * namespace and everything in it, the per-process cache of converged teams, and the periodic
 * reconcile of every team namespace (split out of provider.ts by KOBE-710).
 */

/**
 * Name of the dry-run namespace the admission self-check expects to be refused: under neither
 * team namespace prefix, so the policy refuses it whichever prefix it pins.
 */
export const ADMISSION_PROBE_NAMESPACE = "kaiju-admission-probe";

/** The prefix the admission policy's refusal names ("may only manage <prefix>* namespaces"). */
const ADMISSION_REFUSAL = /may only manage ([a-z0-9-]+)\* namespaces/;
/** How long a converged team namespace is trusted before it is applied again. */
export const TEAM_RECONVERGE_MS = 5 * 60_000;
const RBAC_RETRIES = 6;

export function createTeamOps(
  ctx: ProviderContext,
): Pick<SandboxProvider, "ensureTeam" | "reconcileTeams"> {
  const { kube, isolation, settings, sleep, now, endpointAddresses } = ctx;
  const names = namesOf(settings);

  /**
   * KOBE-751: no team namespace exists under another prefix than the configured one (the start-up
   * check, repeated here when the API could not answer at start). Checked once per process.
   */
  let prefixVerified = false;

  const checkPrefix = async (): Promise<void> => {
    if (prefixVerified) return;
    try {
      await assertTeamNamespacePrefix(kube, names.prefix);
    } catch (err) {
      if (err instanceof TeamNamespacePrefixError) {
        throw new SandboxProvisioningError(err.message);
      }
      throw err;
    }
    prefixVerified = true;
  };

  /**
   * The chart's admission policies confine the server's cluster-wide RBAC and pin isolation. Before
   * provisioning, prove they are in effect: a server-side dry run of a namespace outside the
   * configured prefix must be refused by them, and the refusal must name that same prefix (the
   * chart and the server agree on it). Otherwise refuse to provision (fail closed).
   */
  let admissionVerified = false;

  const checkAdmission = async (): Promise<void> => {
    if (admissionVerified) return;
    try {
      await kube.create(
        {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: ADMISSION_PROBE_NAMESPACE,
            labels: {
              [LABEL_TEAM_NAMESPACE]: "true",
              "pod-security.kubernetes.io/enforce": POD_SECURITY_LEVEL,
            },
          },
        },
        { dryRun: true },
      );
    } catch (err) {
      const pinned =
        err instanceof KubeApiError ? ADMISSION_REFUSAL.exec(err.message)?.[1] : undefined;
      if (pinned === names.prefix) {
        admissionVerified = true;
        return;
      }
      if (pinned !== undefined) {
        throw new SandboxProvisioningError(
          `Kaiju's sandbox admission policy confines the server to ${pinned}* namespaces, but ` +
            `the server is configured for ${names.prefix}*; refusing to provision sandboxes. ` +
            "Render the chart and the server from the same sandbox.teamNamespacePrefix.",
        );
      }
      throw err;
    }
    throw new SandboxProvisioningError(
      "Kaiju's sandbox admission policies are not in effect (a dry-run namespace outside " +
        `${names.prefix}* was allowed); refusing to provision sandboxes. Install the chart's ` +
        "ValidatingAdmissionPolicies (Kubernetes >= 1.30).",
    );
  };

  /**
   * Team namespaces converged by this process, keyed by team id + RuntimeClass. Entries expire so
   * drift (a deleted NetworkPolicy, a changed Service IP, new settings) is repaired.
   */
  const ensured = new Map<string, { readonly at: number; readonly pending: Promise<string> }>();

  /** RoleBindings take a moment to reach the authorizer: retry 403s right after creating one. */
  const applyWithRbacRetry = async (object: KubeObject): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await kube.apply(object);
        return;
      } catch (err) {
        if (!isKubeStatus(err, 403) || attempt >= RBAC_RETRIES) throw err;
        await sleep(100 * 2 ** attempt);
      }
    }
  };

  /**
   * Rancher's namespace webhook refuses namespaces with Pod Security labels unless the caller may
   * `updatepsa` on Rancher projects. Name the webhook and the chart value that grants it.
   */
  const applyNamespace = async (namespace: string, team: TeamRef): Promise<void> => {
    try {
      await kube.apply(namespaceManifest(team, settings));
    } catch (err) {
      if (err instanceof KubeApiError && RANCHER_NAMESPACE_WEBHOOK.test(err.message)) {
        throw new SandboxProvisioningError(rancherRefusal(namespace));
      }
      throw err;
    }
  };

  const convergeTeam = async (
    team: TeamRef,
    verified: VerifiedIsolation,
  ): Promise<{ namespace: string; degraded: readonly string[] }> => {
    const namespace = teamNamespaceName(team, settings);
    await checkPrefix();
    await checkAdmission();
    const existing = await kube.get(ref("v1", "Namespace", namespace));
    if (existing) {
      const owner = existing.metadata.labels?.[LABEL_TEAM_ID];
      if (owner !== team.id) {
        // Never hand another (or a deleted) team's namespace, volumes included, to this team.
        throw new SandboxProvisioningError(
          `Namespace ${namespace} exists but is not labelled for team ${team.id}; refusing to use it`,
        );
      }
      if (existing.metadata.deletionTimestamp) {
        throw new SandboxProvisioningError(`Namespace ${namespace} is being deleted; retry later`);
      }
    }
    await applyNamespace(namespace, team);
    await kube.apply(serverRoleBindingManifest(namespace, settings));
    // The NetworkPolicy goes first: no pod may ever run here without default deny.
    await applyWithRbacRetry(networkPolicyManifest(namespace, settings));
    await applyWithRbacRetry(evalNetworkPolicyManifest(namespace, settings));
    // Scan pods are left out of the namespace-wide policy too (KOBE-341): theirs is in place
    // before any could start, in every team namespace, not only the Registry team's.
    await applyWithRbacRetry(skillScanNetworkPolicyManifest(namespace, settings));
    await kube.apply(resourceQuotaManifest(namespace, settings));
    // The scoped quotas split the team quota between members and evals (KOBE-325). Neither may
    // stop member sandboxes: without the eval quota evals stay inside the team quota; without the
    // member quota members are held by the team quota alone (it includes the eval share). Each
    // failure is logged and the reconcile counts the namespace as failed (TeamQuotaDegraded).
    const degraded: string[] = [];
    for (const manifest of [
      evalResourceQuotaManifest(namespace, settings),
      memberResourceQuotaManifest(namespace, settings),
    ]) {
      try {
        await kube.apply(manifest);
      } catch (err) {
        degraded.push(manifest.metadata.name);
        logger.error(
          { namespace, quota: manifest.metadata.name, err },
          "scoped ResourceQuota could not be applied; members keep starting under the team quota",
        );
      }
    }
    await kube.apply(limitRangeManifest(namespace, settings));
    await kube.apply(sandboxServiceAccountManifest(namespace, settings));
    for (const name of settings.imagePullSecrets) {
      const source = await kube.get(ref("v1", "Secret", name, settings.releaseNamespace));
      if (!source) {
        throw new SandboxProvisioningError(
          `Image pull Secret ${settings.releaseNamespace}/${name} does not exist`,
        );
      }
      await kube.apply(pullSecretManifest(namespace, source, settings));
    }
    const addresses = await endpointAddresses();
    await kube.apply(sandboxTemplateManifest(namespace, verified, settings, addresses));
    await kube.apply(warmPoolManifest(namespace, settings));
    await kube.apply(evalSandboxTemplateManifest(namespace, verified, settings, addresses));
    await kube.apply(evalWarmPoolManifest(namespace, settings));
    return { namespace, degraded };
  };

  const ensureTeam = (team: TeamRef, verified: VerifiedIsolation): Promise<string> => {
    assertTeamRef(team);
    const key = `${team.id}/${verified.runtimeClassName}/${verified.handler}`;
    const cached = ensured.get(key);
    if (cached && now() - cached.at < TEAM_RECONVERGE_MS) return cached.pending;
    // A degraded namespace (a scoped quota refused) still serves its members.
    const entry = { at: now(), pending: convergeTeam(team, verified).then((c) => c.namespace) };
    ensured.set(key, entry);
    // A failed attempt is retried by the next caller rather than cached.
    entry.pending.catch(() => {
      if (ensured.get(key) === entry) ensured.delete(key);
    });
    return entry.pending;
  };

  const reconcileTeams = async (): Promise<TeamReconcileSummary> => {
    const verified = await isolation.require();
    return reconcileTeamNamespaces({
      kube,
      names,
      converge: async (team) => {
        const { namespace, degraded } = await convergeTeam(team, verified);
        // Everything else converged; the namespace still counts as failed until both apply.
        if (degraded.length > 0) throw new TeamQuotaDegradedError(namespace, degraded);
      },
      onFailure: (namespace, err) =>
        logger.warn({ namespace, err }, "team namespace reconcile failed"),
    });
  };

  return { ensureTeam, reconcileTeams };
}
