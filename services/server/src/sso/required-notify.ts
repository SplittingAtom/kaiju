import { and, eq, inArray, isNull, siteRoles, users, type KobeDb } from "@kobe/db";
import { logger } from "../logger.js";
import { CONSOLE_PATHS } from "../mail/console-paths.js";
import type { Mailer, MailMessage } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";

/**
 * KOBE-774: the email to every active site admin (Owner and Admins) when "Require single sign-on"
 * turned itself off because the last enabled identity provider was disabled or deleted. Sent after
 * the change commits; best effort (a failure is logged, the change and its audit event stand).
 */
export interface RequiredNotifyDeps {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
}

export function ssoRequiredOffMessage(publicUrl: string, slug: string, to: string): MailMessage {
  return {
    to,
    subject: "Kobe: single sign-on is no longer required",
    text: [
      `The identity provider ${oneLine(slug)} was turned off or deleted, and it was the last`,
      "enabled one, so Require single sign-on turned itself off: people can sign in with their",
      "password or passkey again.",
      "",
      "To require single sign-on again, turn a provider on, sign in with it and turn the setting",
      `back on: ${new URL(CONSOLE_PATHS.siteSso, publicUrl).href}`,
    ].join("\n"),
  };
}

/** Emails the active site admins; returns how many emails went out. Never throws. */
export async function notifySsoRequiredOff(
  deps: RequiredNotifyDeps,
  slug: string,
): Promise<number> {
  try {
    const admins = await deps.db
      .select({ email: users.email })
      .from(siteRoles)
      .innerJoin(users, eq(users.id, siteRoles.userId))
      .where(and(inArray(siteRoles.role, ["owner", "admin"]), isNull(users.deactivatedAt)));
    let sent = 0;
    for (const { email } of admins) {
      try {
        await deps.mailer.send(ssoRequiredOffMessage(deps.publicUrl, slug, email));
        sent++;
      } catch (err) {
        logger.warn({ err }, "require single sign-on notice could not be sent");
      }
    }
    return sent;
  } catch (err) {
    logger.error({ err }, "require single sign-on notice failed");
    return 0;
  }
}
