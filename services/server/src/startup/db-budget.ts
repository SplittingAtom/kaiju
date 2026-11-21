/**
 * Postgres connection budget (KOBE-736, storage review STO-5). Every server pod holds up to its
 * query pool, its event-stream read pool and one LISTEN connection; the chart passes the server's
 * replica count and the full pools of every other component that connects (scheduler, model
 * gateway, egress proxy). At start the server compares the total with `max_connections` and warns
 * when it leaves less than {@link BUDGET_HEADROOM} free. An estimate of full pools in steady state:
 * rollout surge pods, the migration Job and backups come on top, and nothing is refused.
 */

/** Connections kept free for superusers, the migration Job and operators. */
export const BUDGET_HEADROOM = 10;

export interface ConnectionBudgetInput {
  readonly serverReplicas: number;
  readonly poolMax: number;
  readonly streamPoolMax: number;
  /** Full pools plus LISTEN connections of every other component (the chart computes it). */
  readonly peerConnections: number;
}

/** connections = server replicas x (pool + stream pool + 1 listener) + the other components. */
export function connectionBudget(input: ConnectionBudgetInput): number {
  return input.serverReplicas * (input.poolMax + input.streamPoolMax + 1) + input.peerConnections;
}

export interface BudgetCheck {
  readonly budget: number;
  readonly maxConnections: number;
  readonly exceeded: boolean;
}

/** Reads `max_connections` and warns when the budget exceeds it minus the headroom. */
export async function checkConnectionBudget(
  pool: { query(text: string): Promise<{ rows: unknown[] }> },
  input: ConnectionBudgetInput,
  log: { warn(obj: object, msg?: string): void; info(obj: object, msg?: string): void },
): Promise<BudgetCheck | undefined> {
  const { rows } = await pool.query("SHOW max_connections");
  const raw = (rows[0] as { max_connections?: unknown } | undefined)?.max_connections;
  const maxConnections = Number(raw);
  if (!Number.isInteger(maxConnections) || maxConnections <= 0) {
    log.warn({ value: raw }, "postgres connection budget: max_connections is unreadable");
    return undefined;
  }
  const budget = connectionBudget(input);
  const exceeded = budget > maxConnections - BUDGET_HEADROOM;
  const fields = { budget, maxConnections, headroom: BUDGET_HEADROOM, ...input };
  if (exceeded) {
    log.warn(
      {
        ...fields,
        hint:
          "raise max_connections (postgres.cnpg.parameters with bundled CloudNativePG) or lower " +
          "the pool sizes; docs/install.md, Postgres connections",
      },
      "postgres connection budget exceeds max_connections",
    );
  } else {
    log.info(fields, "postgres connection budget");
  }
  return { budget, maxConnections, exceeded };
}
