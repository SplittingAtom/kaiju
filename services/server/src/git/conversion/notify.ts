import { sql, withTeam, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { readAppName } from "../../branding/settings.js";
import type { MailMessage, Mailer } from "../../mail/mailer.js";
import { oneLine } from "../../mail/messages.js";
import { CONSOLE_PATHS } from "../../mail/console-paths.js";
import { FAILURE_MESSAGES } from "./refusals.js";
import type { ConversionRow } from "./store.js";

/**
 * Tells the member who asked for a conversion how it ended (KOBE-765): one email when it completed
 * and one each time it failed, sent after the outcome committed; a failed send is logged, not
 * retried (the project's conversion state says the same). Names, the host and the outcome only:
 * never a credential or the host's own text. The in-app bell notice (KOBE-819) is written with
 * the end itself, in `bell.ts`.
 */
export interface ConversionNotifyDeps {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
  readonly log: Pick<Logger, "warn">;
}

export function conversionMessage(input: {
  readonly to: string;
  readonly appName: string;
  readonly projectName: string;
  readonly row: Pick<
    ConversionRow,
    "status" | "organization" | "repositoryName" | "baseUrl" | "lastError" | "lastErrorDetail"
  >;
  readonly appUrl: string;
}): MailMessage {
  const { row } = input;
  const project = oneLine(input.projectName);
  const repo = oneLine(`${row.organization}/${row.repositoryName}`, 200);
  const host = new URL(row.baseUrl).host;
  const app = oneLine(input.appName);
  if (row.status === "completed") {
    return {
      to: input.to,
      subject: `${project} is now a Repo (${app})`,
      text: [
        `The project ${project} was converted to a Repo: its history is in ${repo} on ${host}, and that repository is now the project's record.`,
        "",
        `Open ${app}: ${input.appUrl}`,
      ].join("\n"),
    };
  }
  const code = row.lastError as keyof typeof FAILURE_MESSAGES | null;
  const why =
    code !== null && code in FAILURE_MESSAGES
      ? FAILURE_MESSAGES[code]
      : FAILURE_MESSAGES.internal_error;
  return {
    to: input.to,
    subject: `Converting ${project} to a Repo failed (${app})`,
    text: [
      `Converting the project ${project} to a Repo (${repo} on ${host}) stopped: ${why}`,
      ...(row.lastErrorDetail ? ["", `It concerns: ${oneLine(row.lastErrorDetail, 300)}`] : []),
      "",
      `The project is unchanged. Retry or abandon the conversion from the project's menu in ${app}: ${input.appUrl}`,
    ].join("\n"),
  };
}

/** Emails the requester (active members only); nothing without a mail relay. */
export async function notifyConversion(d: ConversionNotifyDeps, row: ConversionRow): Promise<void> {
  if (d.mailer.disabled) return;
  if (row.status !== "completed" && row.status !== "failed") return;
  const facts = await withTeam(d.db, row.teamId, async (tx) => {
    const res = await tx.execute<{ email: string; name: string }>(sql`
      SELECT u.email, p.name FROM users u
        JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = ${row.teamId}
        JOIN projects p ON p.team_id = ${row.teamId} AND p.id = ${row.projectId}
       WHERE u.id = ${row.requestedBy} AND u.deactivated_at IS NULL`);
    return res.rows[0];
  });
  if (!facts) return;
  const appName = await readAppName(d.db);
  await d.mailer.send(
    conversionMessage({
      to: facts.email,
      appName,
      projectName: facts.name,
      row,
      appUrl: `${d.publicUrl}${CONSOLE_PATHS.chat}`,
    }),
  );
}
