import type { BreakGlassNotificationEvent, BreakGlassRecipientRole } from "@kobe/db";
import type { ServerDeps } from "../deps.js";
import { CONSOLE_PATHS } from "../mail/console-paths.js";
import type { MailMessage } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";
import type { SiteGrantDetail } from "./store.js";

/** Site-level break-glass emails (KOBE-648). Who receives them and when: see `outbox.ts`. */

const MINUTE = 60_000;

/**
 * The email for one recipient. Site admins see the reason and the person; Workspace admins see
 * them unless the grant is a legal hold; the person is told their portable memories were read
 * (never under legal hold: they are not a recipient then).
 */
export function siteGrantMessage(
  deps: Pick<ServerDeps, "publicUrl">,
  detail: SiteGrantDetail,
  event: BreakGlassNotificationEvent,
  to: { readonly name: string; readonly email: string },
  options: { role: BreakGlassRecipientRole; wasActive?: boolean },
): MailMessage {
  const { grant } = detail;
  const isSiteAdmin = options.role === "site_admin" || options.role === "requester";
  const isSubject = options.role === "subject";
  const hidden = grant.legalHold && !isSiteAdmin;
  const whose = isSubject
    ? "your portable memories"
    : hidden
      ? "one person's portable memories (restricted: legal hold)"
      : `${oneLine(detail.subject.name)}'s portable memories`;
  const lapsed = event === "expired" && !options.wasActive;
  const withdrawn = event === "revoked" && !options.wasActive;
  const subjects: Record<BreakGlassNotificationEvent, string> = {
    requested: `Break-glass request for ${whose} needs a second admin`,
    approved: `Break-glass access to ${whose} was approved`,
    denied: `Your break-glass request for ${whose} was denied`,
    revoked: withdrawn
      ? `A break-glass request for ${whose} was withdrawn`
      : `Break-glass access to ${whose} was revoked`,
    expired: lapsed
      ? `Your break-glass request for ${whose} lapsed`
      : `Break-glass access to ${whose} ended`,
  };
  const requester = oneLine(detail.requestedBy.name);
  const lines = [
    `${requester} asked for read-only break-glass access to ${whose} on Kobe.`,
    "Portable memories are the preferences that follow a person into every Workspace.",
  ];
  if (event === "requested") {
    lines.push(`Requested window: ${grant.durationMinutes} minutes, starting when approved.`);
    if (grant.legalHold) lines.push("Marked as legal hold: the person is not notified.");
  }
  if (event === "approved" && grant.startsAt && grant.expiresAt) {
    const approver = oneLine(detail.approvedBy?.name ?? "a site admin");
    lines.push(
      grant.selfApproved
        ? `${approver} approved it alone: this site has a single admin (flagged).`
        : `${approver} approved it.`,
      `Access is read-only and ends at ${grant.expiresAt.toUTCString()} ` +
        `(${Math.round((grant.expiresAt.getTime() - grant.startsAt.getTime()) / MINUTE)} minutes). ` +
        "Every read is recorded in the Site audit log and in the audit view of each Workspace the person belongs to.",
    );
  }
  if (event === "denied") {
    lines.push(`${oneLine(detail.decidedBy?.name ?? "A site admin")} denied it.`);
  }
  if (event === "revoked") {
    lines.push(`${oneLine(detail.decidedBy?.name ?? "A site admin")} ended it before it expired.`);
  }
  if (event === "expired") {
    lines.push(lapsed ? "Nobody decided within 24 hours." : "The time box ended.");
  }
  if (!hidden) lines.push("", "Reason given:", grant.reason);
  if (isSiteAdmin) {
    lines.push("", `Review it: ${deps.publicUrl}${CONSOLE_PATHS.sitePortableBreakGlass}`);
  } else if (!isSubject) {
    lines.push("", `See your Workspace's audit view: ${deps.publicUrl}${CONSOLE_PATHS.teamAudit}`);
  }
  return { to: to.email, subject: subjects[event], text: lines.join("\n") };
}
