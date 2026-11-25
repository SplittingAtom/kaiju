/** Team console: the team's audit view (`/v1/team/audit`, team.audit.read; KOBE-15). */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { ViaAgent } from "../audit-via";

const enc = encodeURIComponent;

export interface TeamAuditEvent {
  readonly id: string;
  readonly seq: number;
  readonly at: string;
  readonly actor: {
    readonly kind: "user" | "agent" | "system";
    readonly id: string | null;
    readonly name: string | null;
    readonly email: string | null;
  };
  readonly action: string;
  readonly target: Record<string, unknown>;
  /** Done through a Kaiju MCP admin tool (KOBE-623): thread, run, tool call. */
  readonly viaAgent?: ViaAgent;
}

export interface TeamAuditPage {
  readonly events: readonly TeamAuditEvent[];
  readonly nextCursor: string | null;
  /**
   * The built-in connectors' Pi server segments before the rename → since (KOBE-826); events keep
   * the tool names they were recorded with. Absent from a server of the release before it.
   */
  readonly renamedToolSegments?: Readonly<Record<string, string>>;
}

export function listTeamAudit(
  teamId: string,
  before?: string | null,
): Promise<ApiResult<TeamAuditPage>> {
  const query = before ? `&before=${enc(before)}` : "";
  return apiRequest<TeamAuditPage>(`/v1/team/audit?limit=50${query}`, { teamId });
}
