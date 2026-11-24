import { USAGE_KINDS, type UsageKind } from "@kaiju/db";

/**
 * Whether `run_usage.kind` can record this purpose. A server-call purpose the protocol has but
 * the usage table does not yet (KOBE-390 `memory_learn`) is refused at authentication, so a call
 * is never made without its usage row.
 */
export function isUsageKind(kind: string): kind is UsageKind {
  return (USAGE_KINDS as readonly string[]).includes(kind);
}
