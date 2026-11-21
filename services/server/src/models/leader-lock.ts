import type { ListenSession } from "../pg-listen.js";

/** The backend that held the lock: enough to recognise it again, and nothing else. */
export interface LockHolder {
  readonly pid: number;
  /** `pg_stat_activity.backend_start` as text: tells a reused pid apart. */
  readonly started: string;
  readonly app: string;
}

export type AcquireResult = "acquired" | "busy" | "reclaimed";

/** SQLSTATE 42501: the role may not signal that backend. */
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * A session advisory lock on the LISTEN connection that makes one replica the leader (KOBE-704
 * review). When this process loses its LISTEN connection to a half-open socket, Postgres does not
 * see the client go and the old backend keeps the lock until TCP keepalive gives up; the listener
 * sets server-side keepalives so that takes about a minute, and this reclaims sooner: having held
 * the lock, a failed attempt on the new connection ends the old backend, but only if a backend
 * with the same pid, `backend_start` and `application_name` still exists (never a reused pid,
 * never another replica's healthy leader). Postgres lets a role end its own role's backends;
 * where it does not, this logs once and the keepalives remain.
 */
export class SessionLeaderLock {
  #holder: LockHolder | undefined;
  /** The holder recorded before this process lost its connection, to reclaim once. */
  #stale: LockHolder | undefined;

  constructor(
    private readonly key: number,
    private readonly log: { warn(obj: object, msg?: string): void },
  ) {}

  get holder(): LockHolder | undefined {
    return this.#holder;
  }

  async tryAcquire(session: ListenSession): Promise<AcquireResult> {
    const res = await session.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [
      this.key,
    ]);
    if (res.rows[0]?.ok) {
      this.#stale = undefined;
      this.#holder = await this.#self(session);
      return "acquired";
    }
    return (await this.#reclaim(session)) ? "reclaimed" : "busy";
  }

  /** This process's LISTEN connection was lost: its backend may still hold the lock. */
  lost(): void {
    if (this.#holder) this.#stale = this.#holder;
    this.#holder = undefined;
  }

  async release(session: ListenSession): Promise<void> {
    this.#holder = undefined;
    this.#stale = undefined;
    if (!session.active) return;
    await session.query("SELECT pg_advisory_unlock($1)", [this.key]);
  }

  async #self(session: ListenSession): Promise<LockHolder | undefined> {
    const { rows } = await session.query<{ pid: number; started: string; app: string }>(
      `SELECT pg_backend_pid() AS pid, a.backend_start::text AS started,
              current_setting('application_name') AS app
         FROM pg_stat_activity a WHERE a.pid = pg_backend_pid()`,
    );
    const row = rows[0];
    return row ? { pid: Number(row.pid), started: row.started, app: row.app } : undefined;
  }

  /** Ends this process's own stale backend (once); true when one was ended. */
  async #reclaim(session: ListenSession): Promise<boolean> {
    const stale = this.#stale;
    if (!stale) return false;
    this.#stale = undefined;
    try {
      const { rows } = await session.query<{ ok: boolean }>(
        `SELECT pg_terminate_backend(a.pid) AS ok FROM pg_stat_activity a
          WHERE a.pid = $1 AND a.backend_start::text = $2 AND a.application_name = $3
            AND a.pid <> pg_backend_pid()`,
        [stale.pid, stale.started, stale.app],
      );
      if (rows[0]?.ok) {
        this.log.warn(
          { pid: stale.pid },
          "leader lock: ended this replica's old LISTEN backend that still held the lock",
        );
        return true;
      }
      return false;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      this.log.warn(
        { err },
        code === INSUFFICIENT_PRIVILEGE
          ? "leader lock: the database role may not end its old backend; the lock frees once " +
              "Postgres' TCP keepalive drops it"
          : "leader lock: could not end the old backend",
      );
      return false;
    }
  }
}
