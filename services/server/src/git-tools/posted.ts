import { sql, type KobeTx } from "@kobe/db";

/**
 * The last line Kaiju adds to every pull request, issue and comment it posts (spec workspace-git
 * G13): the member on whose behalf the agent acted and a link to the conversation. Built by the
 * server only, the same way for the approval card and the executor, so the card shows exactly the
 * text that is posted.
 */

/** The member's name as plain text in Markdown: one line, bounded, Markdown and HTML escaped. */
export function markdownName(name: string): string {
  const one = name.replace(/\s+/g, " ").trim().slice(0, 120) || "a member";
  return one.replace(/[\\`*_{}[\]()#+!|<>~]/g, (c) => `\\${c}`);
}

export function conversationLink(publicUrl: string, threadId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/?thread=${threadId.toLowerCase()}`;
}

/** The footer for a body (`opened`: a pull request or issue; otherwise a comment). */
export function footerLine(
  kind: "opened" | "posted",
  memberName: string,
  publicUrl: string,
  threadId: string,
): string {
  const verb = kind === "opened" ? "Opened" : "Posted";
  return `${verb} by ${markdownName(memberName)} via Kaiju, from conversation ${conversationLink(publicUrl, threadId)}`;
}

/** The body exactly as it is sent to the host. */
export function postedBody(body: string, footer: string): string {
  const trimmed = body.replace(/\s+$/, "");
  return trimmed === "" ? footer : `${trimmed}\n\n---\n${footer}`;
}

/** The member's display name; never their email (it would land on the host). */
export async function memberName(tx: Pick<KobeTx, "execute">, userId: string): Promise<string> {
  const res = await tx.execute<{ name: string | null }>(
    sql`SELECT name FROM public.users WHERE id = ${userId}`,
  );
  return res.rows[0]?.name?.trim() || "a Kaiju member";
}
