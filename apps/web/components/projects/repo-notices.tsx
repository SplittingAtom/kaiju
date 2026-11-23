"use client";

/**
 * In-app notices in the Files panel (KOBE-768): a conversion that finished or failed while the
 * panel was open, and, for Workspace admins, a git connection whose credential expires soon (the
 * Git section has the details; both are also emailed). Each can be dismissed for this session.
 */
import Link from "next/link";
import { useState } from "react";
import { isAdminView } from "../../lib/admin/api/team/git";
import { syncTimeText } from "../../lib/workspace/rebuild";
import { useWorkspaceProjects } from "./workspace-projects";

export function RepoNotices() {
  const ctx = useWorkspaceProjects();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  if (!ctx) return null;
  const expiring = (ctx.git?.connections ?? [])
    .filter(isAdminView)
    .filter((c) => c.credential.expiresSoon && !hidden.has(`expiry:${c.id}`));
  if (ctx.notices.length === 0 && expiring.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs" aria-label="Repo notices">
      {ctx.notices.map((n) => (
        <li key={n.key} role="status" className="flex items-start gap-2">
          <span className={n.tone === "failed" ? "text-destructive flex-1" : "flex-1"}>
            {n.text}
          </span>
          <button
            type="button"
            className="underline"
            aria-label={`Dismiss: ${n.text}`}
            onClick={() => ctx.dismissNotice(n.key)}
          >
            Dismiss
          </button>
        </li>
      ))}
      {expiring.map((c) => (
        <li key={c.id} role="note" className="flex items-start gap-2">
          <span className="flex-1">
            {`The credential of the git connection ${c.displayName} expires ${syncTimeText(c.credential.expiresAt)}. `}
            <Link href="/admin/team/git" className="underline">
              Replace it in the Git section
            </Link>
          </span>
          <button
            type="button"
            className="underline"
            aria-label={`Dismiss the notice about ${c.displayName}`}
            onClick={() => setHidden((s) => new Set([...s, `expiry:${c.id}`]))}
          >
            Dismiss
          </button>
        </li>
      ))}
    </ul>
  );
}
