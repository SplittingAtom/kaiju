import type { SemanticMemoryActorKind } from "@kaiju/protocol";

/**
 * How a version's author kind is shown to someone who isn't a Site curator (KOBE-403, SM20): a
 * Site memory written from a Workspace's proposal reads like any other Site memory, set by the
 * Site (`user`), so nothing hints at a Workspace origin. Only Site versions can be `proposal`.
 * Runs always use this (their context reaches every member); the console only for non-curators.
 */
export const presentedActorKind = (kind: SemanticMemoryActorKind): SemanticMemoryActorKind =>
  kind === "proposal" ? "user" : kind;
