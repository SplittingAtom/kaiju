import {
  SYSTEM_ACTOR,
  and,
  eq,
  gitConnections,
  isNotNull,
  lte,
  or,
  isNull,
  lt,
  readGitConnections,
  scanTeams,
  sql,
  withTeam,
  type GitConnectionRecord,
  type KobeDb,
} from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { readAppName } from "../branding/settings.js";
import type { MailMessage, Mailer } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";
import { CONSOLE_PATHS } from "../mail/console-paths.js";
import { GIT_EXPIRY_NOTICE_DAYS } from "./connection-view.js";

/**
 * Token-expiry notices (KOBE-760, spec G6): when a connection's access token lapses within
 * {@link GIT_EXPIRY_NOTICE_DAYS} days (the expiry the host reported at the last test or check),
 * every active Workspace admin is emailed once per credential. The claim (`expiry_notified_at`,
 * cleared when the credential is replaced) and the audit row commit together before any email is
 * sent; a failed send is logged, not retried (the Git section shows the expiry too). Names,
 * host and date only: never the credential or its hint.
 */
export interface GitExpiryDeps {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
  readonly logger: Pick<Logger, "warn" | "error" | "info">;
  readonly now?: () => number;
}

const DAY_MS = 86_400_000;

export function gitExpiryMessage(input: {
  readonly to: string;
  readonly appName: string;
  readonly teamName: string;
  readonly connection: Pick<
    GitConnectionRecord,
    "displayName" | "organization" | "baseUrl" | "credentialExpiresAt"
  >;
  readonly consoleUrl: string;
  readonly now: number;
}): MailMessage {
  const c = input.connection;
  const name = oneLine(c.displayName);
  const team = oneLine(input.teamName);
  const app = oneLine(input.appName);
  const expires = c.credentialExpiresAt ?? new Date(input.now);
  const lapsed = expires.getTime() <= input.now;
  const date = expires.toISOString().slice(0, 10);
  return {
    to: input.to,
    subject: lapsed
      ? `The git connection ${name} needs a new token (${app})`
      : `The token of the git connection ${name} expires on ${date} (${app})`,
    text: [
      lapsed
        ? `The access token of the git connection ${name} (${oneLine(c.organization)} on ${new URL(c.baseUrl).host}) expired on ${date}. Agents in the ${team} Workspace cannot use the connection until a Workspace admin replaces the token.`
        : `The access token of the git connection ${name} (${oneLine(c.organization)} on ${new URL(c.baseUrl).host}) expires on ${date}. Create a new token on the host and replace the credential before then, or agents in the ${team} Workspace lose access.`,
      "",
      `You get this as a Workspace admin of ${team}. Replace the credential in the Git section: ${input.consoleUrl}`,
    ].join("\n"),
  };
}

interface Due {
  readonly teamName: string;
  readonly connection: GitConnectionRecord;
}

/** Connections whose token lapses within the window and whose admins were not told yet. */
function dueOf(db: KobeDb, before: Date): Promise<Due[][]> {
  return scanTeams(db, "git expiry notices", async (tx, team) => {
    const ids = await tx
      .select({ id: gitConnections.id })
      .from(gitConnections)
      .where(
        and(
          eq(gitConnections.teamId, team.id),
          isNotNull(gitConnections.credentialExpiresAt),
          lte(gitConnections.credentialExpiresAt, before),
          or(
            isNull(gitConnections.expiryNotifiedAt),
            lt(gitConnections.expiryNotifiedAt, gitConnections.credentialUpdatedAt),
          ),
        ),
      );
    if (ids.length === 0) return undefined;
    const wanted = new Set(ids.map((r) => r.id));
    const rows = (await readGitConnections(tx, team.id)).filter((c) => wanted.has(c.id));
    return rows.map((connection) => ({ teamName: team.name, connection }));
  });
}

/** Claims one notice and records it; the admins' addresses, or undefined if already claimed. */
function claim(db: KobeDb, c: GitConnectionRecord): Promise<string[] | undefined> {
  return withTeam(db, c.teamId, async (tx) => {
    const claimed = await tx
      .update(gitConnections)
      .set({ expiryNotifiedAt: sql`now()` })
      .where(
        and(
          eq(gitConnections.teamId, c.teamId),
          eq(gitConnections.id, c.id),
          sql`date_trunc('milliseconds', ${gitConnections.credentialUpdatedAt}) = ${c.credentialUpdatedAt.toISOString()}::timestamptz`,
          or(
            isNull(gitConnections.expiryNotifiedAt),
            lt(gitConnections.expiryNotifiedAt, gitConnections.credentialUpdatedAt),
          ),
        ),
      )
      .returning({ id: gitConnections.id });
    if (claimed.length === 0) return undefined;
    const { rows } = await tx.execute<{ email: string }>(sql`
      SELECT u.email FROM team_members tm
        JOIN users u ON u.id = tm.user_id AND u.deactivated_at IS NULL
       WHERE tm.team_id = ${c.teamId} AND tm.role = 'team_admin'
       ORDER BY u.email`);
    await recordAudit(tx, {
      action: "git.connection.expiry_notified",
      teamId: c.teamId,
      actor: SYSTEM_ACTOR,
      target: {
        connectionId: c.id,
        expiresAt: (c.credentialExpiresAt ?? new Date()).toISOString(),
        notified: rows.length,
      },
    });
    return rows.map((r) => r.email);
  });
}

/** One pass: claims and sends every notice due; returns how many connections were noticed. */
export async function notifyGitTokenExpiry(d: GitExpiryDeps): Promise<number> {
  // A process without a mail relay leaves notices to one that has one (claims nothing).
  if (d.mailer.disabled) return 0;
  const now = d.now?.() ?? Date.now();
  const due = (await dueOf(d.db, new Date(now + GIT_EXPIRY_NOTICE_DAYS * DAY_MS))).flat();
  if (due.length === 0) return 0;
  const appName = await readAppName(d.db);
  const consoleUrl = `${d.publicUrl}${CONSOLE_PATHS.teamGit}`;
  let noticed = 0;
  for (const { teamName, connection } of due) {
    let emails: string[] | undefined;
    try {
      emails = await claim(d.db, connection);
    } catch (err) {
      d.logger.error({ err, team_id: connection.teamId }, "git expiry notice not recorded");
      continue;
    }
    if (emails === undefined) continue;
    noticed += 1;
    for (const to of emails) {
      try {
        await d.mailer.send(
          gitExpiryMessage({ to, appName, teamName, connection, consoleUrl, now }),
        );
      } catch (err) {
        d.logger.warn(
          { err, team_id: connection.teamId, connection_id: connection.id },
          "git expiry email not sent",
        );
      }
    }
  }
  return noticed;
}
