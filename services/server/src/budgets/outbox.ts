import {
  budgetAlertEmails,
  eq,
  sql,
  teams,
  users,
  withTeam,
  type KaijuDb,
  type KaijuTx,
} from "@kaiju/db";
import type { Logger } from "pino";
import type { Mailer, MailMessage } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";
import { CONSOLE_PATHS } from "../mail/console-paths.js";

/**
 * Budget alert emails (KOBE-42): queued with the alert in its transaction, delivered here **at
 * least once** — rows are claimed with a lease, marked sent once the SMTP server accepted them,
 * retried with backoff, given up (`failed`) after {@link BUDGET_EMAIL_MAX_ATTEMPTS}. A recipient who
 * left (deactivated) is skipped. Plain text, amounts and names only.
 */
export const BUDGET_EMAIL_MAX_ATTEMPTS = 8;
const LEASE = "5 minutes";
const BATCH = 50;
const backoffMinutes = (attempts: number) => Math.min(2 ** attempts, 60);

type Claimed = {
  id: string;
  attempts: number;
  recipient_id: string;
  team_id: string | null;
  scope: "site" | "team" | "user";
  user_id: string | null;
  period: "month" | "day";
  threshold: number;
  unit: "usd" | "tokens";
  limit_amount: string;
  spent_amount: string;
  superseded: boolean;
};

const money = (v: number) => `$${v.toFixed(2)}`;
const amount = (unit: Claimed["unit"], v: number) =>
  unit === "usd" ? money(v) : `${Math.round(v).toLocaleString("en-US")} tokens`;

export function budgetAlertMessage(input: {
  readonly to: string;
  readonly scope: Claimed["scope"];
  readonly own: boolean;
  readonly teamName: string | null;
  readonly period: Claimed["period"];
  readonly threshold: number;
  readonly unit: Claimed["unit"];
  readonly limit: number;
  readonly spent: number;
  readonly link: string;
}): MailMessage {
  const team = input.teamName ? oneLine(input.teamName) : null;
  const whose =
    input.scope === "site"
      ? "The site's"
      : input.scope === "team"
        ? `The ${team ?? "team"} team's`
        : input.own
          ? `Your (${team ?? "team"})`
          : `A member's (${team ?? "team"})`;
  const period = input.period === "month" ? "monthly" : "daily";
  const reached = input.threshold >= 100;
  const kind = input.unit === "tokens" ? "token" : "model";
  return {
    to: input.to,
    subject: reached
      ? `${whose} ${period} ${kind} budget is used up`
      : `${whose} ${period} ${kind} budget is ${input.threshold}% used`,
    text: [
      `${whose} ${period} ${kind} budget: ${amount(input.unit, input.spent)} of ${amount(input.unit, input.limit)} used.`,
      "",
      reached
        ? "New model calls and runs are refused until the period ends or the budget is raised; runs in progress stop after their current step."
        : "When it is used up, new model calls and runs will be refused.",
      "",
      `Budgets and usage: ${input.link}`,
    ].join("\n"),
  };
}

/**
 * Where a budget email links: site admins to site usage; a member about their own budget to the
 * chat, whose budget banner shows it (members can't open the team console); team admins to the
 * team's budgets.
 */
export function budgetAlertPath(scope: Claimed["scope"], own: boolean): string {
  if (scope === "site") return CONSOLE_PATHS.siteUsage;
  if (scope === "user" && own) return CONSOLE_PATHS.chat;
  return CONSOLE_PATHS.teamBudgets;
}

/**
 * At most this many budget emails per person per UTC day, over the Site and every Workspace
 * together (KOBE-786, owner decision 2026-11-22); the rest are skipped (`daily_limit`) and logged.
 */
export const BUDGET_EMAILS_PER_RECIPIENT_PER_DAY = 20;

/** Days of per-person counts the retention pass keeps (today and yesterday). */
const COUNT_DAYS_KEPT = 2;

/**
 * Takes one of today's (UTC) budget email slots of `recipientId`, in one statement: the row is
 * created or raised only while under the cap, so concurrent replicas queue on it and never pass
 * the cap. Returns the day taken (to give the slot back on a failed send), or null at the cap.
 * The count table holds no team id and nothing from a Workspace (site-wide, KOBE-786).
 */
export async function reserveBudgetEmailSlot(
  db: KaijuDb | KaijuTx,
  recipientId: string,
): Promise<string | null> {
  const { rows } = await db.execute<{ day: string }>(sql`
    INSERT INTO budget_email_daily_counts AS c (recipient_id, day, sent)
    VALUES (${recipientId}::uuid, (now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (recipient_id, day) DO UPDATE SET sent = c.sent + 1
     WHERE c.sent < ${BUDGET_EMAILS_PER_RECIPIENT_PER_DAY}
    RETURNING c.day::text AS day`);
  return rows[0]?.day ?? null;
}

/** Gives back a slot taken by {@link reserveBudgetEmailSlot} whose send failed. */
async function releaseBudgetEmailSlot(tx: KaijuTx, recipientId: string, day: string) {
  await tx.execute(sql`
    UPDATE budget_email_daily_counts SET sent = sent - 1
     WHERE recipient_id = ${recipientId}::uuid AND day = ${day}::date AND sent > 0`);
}

/** Deletes per-person counts of days before yesterday (UTC); run by the retention pass. */
export async function sweepBudgetEmailCounts(db: KaijuDb): Promise<number> {
  const { rowCount } = await db.execute(sql`
    DELETE FROM budget_email_daily_counts
     WHERE day < (now() AT TIME ZONE 'UTC')::date - ${COUNT_DAYS_KEPT - 1}::int`);
  return rowCount ?? 0;
}

interface DeliverOptions {
  readonly db: KaijuDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
  readonly logger: Logger;
}

/**
 * Delivers due budget emails in every context their alerts are visible in (RLS, KOBE-42 review):
 * the site's (no team), then each team's. Never throws; returns how many were sent.
 */
export async function deliverBudgetEmails(options: DeliverOptions): Promise<number> {
  let sent = await deliverIn(options, null);
  try {
    const all = await options.db.select({ id: teams.id }).from(teams);
    for (const team of all) sent += await deliverIn(options, team.id);
  } catch (err) {
    options.logger.error({ err }, "budget email delivery failed");
  }
  return sent;
}

async function deliverIn(options: DeliverOptions, teamId: string | null): Promise<number> {
  const { db, mailer, logger } = options;
  const inContext = <T>(fn: (tx: KaijuTx) => Promise<T>): Promise<T> =>
    teamId ? withTeam(db, teamId, fn) : db.transaction(fn);
  type Settle = Parameters<ReturnType<KaijuTx["update"]>["set"]>[0];
  const settle = (id: string, values: Settle, slot?: { recipient: string; day: string }) =>
    inContext(async (tx) => {
      if (slot) await releaseBudgetEmailSlot(tx, slot.recipient, slot.day);
      await tx.update(budgetAlertEmails).set(values).where(eq(budgetAlertEmails.id, id));
    });
  let sent = 0;
  try {
    const claimed = await inContext((tx) =>
      tx.execute<Claimed>(sql`
        UPDATE budget_alert_emails e SET attempts = e.attempts + 1,
               next_attempt_at = now() + ${LEASE}::interval
          FROM budget_alerts a
         WHERE a.id = e.alert_id
           AND e.id IN (
               -- This context's emails only (KOBE-786): RLS also shows a team the Site's, which
               -- would otherwise fill the batch and leave the team's waiting.
               SELECT q.id FROM budget_alert_emails q JOIN budget_alerts qa ON qa.id = q.alert_id
                WHERE q.status = 'pending' AND q.next_attempt_at <= now()
                  AND qa.team_id IS NOT DISTINCT FROM ${teamId}::uuid
                ORDER BY q.created_at LIMIT ${BATCH} FOR UPDATE OF q SKIP LOCKED)
        RETURNING e.id, e.attempts, e.recipient_id, a.team_id, a.scope, a.user_id, a.period,
                  a.threshold, a.unit, a.limit_amount, a.spent_amount,
                  (a.threshold < 100 AND EXISTS (
                     SELECT 1 FROM budget_alerts b
                      WHERE b.team_id IS NOT DISTINCT FROM a.team_id
                        AND b.user_id IS NOT DISTINCT FROM a.user_id
                        AND b.scope = a.scope AND b.unit = a.unit AND b.period = a.period
                        AND b.period_start = a.period_start AND b.threshold = 100)) AS superseded`),
    );
    for (const row of claimed.rows) {
      const [to] = await db
        .select({ email: users.email, off: users.deactivatedAt })
        .from(users)
        .where(eq(users.id, row.recipient_id));
      if (!to || to.off !== null) {
        await settle(row.id, { status: "skipped", lastError: "recipient_inactive" });
        continue;
      }
      // An 80 % warning whose budget is already used up says less than the 100 % email.
      if (row.superseded) {
        await settle(row.id, { status: "skipped", lastError: "superseded" });
        continue;
      }
      const [team] = row.team_id
        ? await db.select({ name: teams.name }).from(teams).where(eq(teams.id, row.team_id))
        : [];
      // The cap counts the Site's and every Workspace's emails to this person (KOBE-786).
      const day = await reserveBudgetEmailSlot(db, row.recipient_id);
      if (day === null) {
        logger.warn({ recipient: row.recipient_id }, "budget emails per day reached: skipped");
        await settle(row.id, { status: "skipped", lastError: "daily_limit" });
        continue;
      }
      try {
        await mailer.send(alertFor(row, to.email, team?.name ?? null, options.publicUrl));
      } catch (err) {
        const giveUp = row.attempts >= BUDGET_EMAIL_MAX_ATTEMPTS;
        logger.warn({ err, emailId: row.id, giveUp }, "budget alert email failed");
        await settle(
          row.id,
          giveUp
            ? { status: "failed", lastError: "smtp_error" }
            : {
                lastError: "smtp_error",
                nextAttemptAt: sql`now() + make_interval(mins => ${backoffMinutes(row.attempts)})`,
              },
          { recipient: row.recipient_id, day },
        );
        continue;
      }
      await settle(row.id, { status: "sent", sentAt: sql`now()`, lastError: null });
      sent++;
    }
  } catch (err) {
    logger.error({ err, teamId }, "budget email delivery failed");
  }
  return sent;
}

function alertFor(row: Claimed, to: string, teamName: string | null, publicUrl: string) {
  const own = row.user_id === row.recipient_id;
  return budgetAlertMessage({
    to,
    scope: row.scope,
    own,
    teamName,
    period: row.period,
    threshold: row.threshold,
    unit: row.unit,
    limit: Number(row.limit_amount),
    spent: Number(row.spent_amount),
    link: `${publicUrl}${budgetAlertPath(row.scope, own)}`,
  });
}
