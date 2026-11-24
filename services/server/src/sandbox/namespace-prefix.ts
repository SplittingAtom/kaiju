import type { Logger } from "pino";
import {
  LABEL_TEAM_NAMESPACE,
  TEAM_NAMESPACE_PREFIXES,
  type TeamNamespacePrefix,
} from "./constants.js";
import type { KubeClient } from "./kube.js";

/**
 * KOBE-751: exactly one team namespace prefix is in force per install. An install created before
 * the rename keeps `kobe-team-`; the chart detects it on upgrade, and this check refuses to run
 * when team namespaces exist under a prefix other than the configured one (for example after an
 * offline render that could not detect it), naming the value to set. The server never adopts or
 * touches a namespace under another prefix, so without this check such an install would silently
 * start new namespaces beside the old ones.
 */

const SHOWN = 5;

export class TeamNamespacePrefixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamNamespacePrefixError";
  }
}

/** Team namespaces (by label) whose names are not under the configured prefix, sorted. */
export async function foreignTeamNamespaces(
  kube: Pick<KubeClient, "list">,
  prefix: TeamNamespacePrefix,
): Promise<string[]> {
  const namespaces = await kube.list("v1", "Namespace", undefined, `${LABEL_TEAM_NAMESPACE}=true`);
  return namespaces
    .map((ns) => ns.metadata.name)
    .filter((name) => !name.startsWith(prefix))
    .sort();
}

/** The refusal: which namespaces, and which value to set. */
export function prefixMismatchMessage(
  prefix: TeamNamespacePrefix,
  foreign: readonly string[],
): string {
  const shown = foreign.slice(0, SHOWN).join(", ");
  const more = foreign.length > SHOWN ? ` and ${foreign.length - SHOWN} more` : "";
  const found = new Set(
    foreign.map((name) => TEAM_NAMESPACE_PREFIXES.find((p) => name.startsWith(p))),
  );
  const head =
    `Team namespaces exist under another prefix than the configured ` +
    `sandbox.teamNamespacePrefix "${prefix}": ${shown}${more}.`;
  const [only] = found;
  if (found.size === 1 && only !== undefined) {
    return (
      `${head} Set the Helm value sandbox.teamNamespacePrefix to "${only}" (the prefix this ` +
      `install's team namespaces use) and upgrade again; moving an install to another prefix is ` +
      `not supported.`
    );
  }
  return (
    `${head} They are labelled ${LABEL_TEAM_NAMESPACE}=true but are not all under one of the ` +
    `prefixes Kaiju uses (${TEAM_NAMESPACE_PREFIXES.join(", ")}). Set ` +
    `sandbox.teamNamespacePrefix to the prefix of this install's team namespaces, and remove the ` +
    `label from namespaces Kaiju did not create.`
  );
}

/** Throws TeamNamespacePrefixError when team namespaces exist under another prefix. */
export async function assertTeamNamespacePrefix(
  kube: Pick<KubeClient, "list">,
  prefix: TeamNamespacePrefix,
): Promise<void> {
  const foreign = await foreignTeamNamespaces(kube, prefix);
  if (foreign.length > 0)
    throw new TeamNamespacePrefixError(prefixMismatchMessage(prefix, foreign));
}

/**
 * The start-up check (server and scheduler): a mismatch stops the process. When the Kubernetes
 * API cannot answer, the process starts and the provider runs the same check before it creates or
 * converges any team namespace (fail closed there, see provider/team.ts).
 */
export async function checkTeamNamespacePrefixAtStart(
  kube: Pick<KubeClient, "list">,
  prefix: TeamNamespacePrefix,
  log: Pick<Logger, "warn" | "info">,
): Promise<void> {
  try {
    await assertTeamNamespacePrefix(kube, prefix);
    log.info({ prefix }, "team namespace prefix checked");
  } catch (err) {
    if (err instanceof TeamNamespacePrefixError) throw err;
    log.warn(
      { err, prefix },
      "could not check the team namespace prefix at start; it is checked before provisioning",
    );
  }
}
