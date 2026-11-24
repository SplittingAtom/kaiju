"use client";

import { ShieldAlertIcon } from "lucide-react";
import type { KobeEventPayload } from "@kobe/protocol";
import { changeRows } from "../../lib/chat/admin-change";
import { visible } from "../../lib/security/visible";
import { cn } from "../../lib/utils";
import { toneClass } from "../ui/status";
import styles from "./chat.module.css";

type Requested = KobeEventPayload<"approval.requested">;

const RISK_LABEL: Record<Requested["risk"], string> = {
  read: "Reads data",
  write: "Changes data",
  destructive: "Can delete or overwrite",
};

/** Anything outside printable ASCII in a tool name (lookalike letters, hidden characters). */
const NON_ASCII = /[^\x20-\x7e]/;

/** Pretty JSON of the input, with invisible characters escaped (the newlines are formatting). */
export function pretty(input: unknown): string {
  try {
    return visible(JSON.stringify(input, null, 2) ?? "");
  } catch {
    return "";
  }
}

interface RememberInput {
  readonly scope: string;
  readonly path: string;
  readonly content: string;
  readonly mode: string | undefined;
}

function rememberInput(tool: string, input: unknown): RememberInput | undefined {
  if (tool !== "remember" || input === null || typeof input !== "object") return undefined;
  const { scope, path, content, mode } = input as Record<string, unknown>;
  if (typeof path !== "string" || typeof content !== "string") return undefined;
  if (scope !== "user" && scope !== "project") return undefined;
  return { scope, path, content, mode: typeof mode === "string" ? mode : undefined };
}

/**
 * The input being approved. A `remember` call (KOBE-158) shows the text exactly as it would be
 * stored: plain text only (never HTML or markdown, so no links or images), hidden characters as
 * visible escapes. Anything else is the JSON of the input.
 */
export function ApprovedInput({ tool, input }: { readonly tool: string; readonly input: unknown }) {
  const mem = rememberInput(tool, input);
  if (!mem) {
    return (
      <pre className={styles.toolPre} aria-label="Input to approve">
        {pretty(input)}
      </pre>
    );
  }
  return (
    <>
      <p>
        Saved to{" "}
        <strong>{mem.scope === "project" ? "project memory" : "your personal memory"}</strong> in{" "}
        <span className={styles.toolName}>{visible(mem.path)}</span> (
        {mem.mode === "append" ? "added to the end of the file" : "replaces the file"}):
      </p>
      <pre className={styles.toolPre} aria-label="Memory to store">
        {visible(mem.content)}
      </pre>
    </>
  );
}

/**
 * A Kaiju admin write's header (KOBE-623, spec kobe-admin-mcp §6): where it applies, the server's
 * summary built from the input (names resolved, never model text) and the change before → after.
 * The exact input is still shown in full below it.
 */
export function AdminChange({
  admin,
  input,
}: {
  readonly admin: NonNullable<Requested["admin"]>;
  readonly input: unknown;
}) {
  const rows = changeRows(input);
  return (
    <div data-kobe-admin-change="">
      <p className={styles.who}>
        Scope: <strong>{visible(admin.scope_label)}</strong>
      </p>
      <p aria-label="Change summary">{visible(admin.summary)}</p>
      {rows.length > 0 && (
        <table aria-label="Before and after" className={styles.toolPre}>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.field}>
                <th scope="row">{visible(r.field)}</th>
                <td>{visible(r.before)}</td>
                <td>{visible(r.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={styles.hint}>
        Admin changes are asked every time: never remembered, never approved with others.
      </p>
    </div>
  );
}

/**
 * The card's title (tool name escaped, risk), a warning for a non-ASCII tool name, and why the
 * call needs approval.
 */
export function ApprovalTitle({
  ids,
  requested,
  toolShown,
}: {
  readonly ids: string;
  readonly requested: Requested;
  readonly toolShown: string;
}) {
  const admin = requested.admin;
  return (
    <>
      <p id={`${ids}-title`} className={styles.approvalTitle}>
        <ShieldAlertIcon aria-hidden className={cn(styles.approvalIcon, toneClass("attention"))} />
        {admin !== undefined && (
          <>
            <strong>Admin change:</strong>{" "}
          </>
        )}
        <strong>Approval needed</strong> to run <span className={styles.toolName}>{toolShown}</span>{" "}
        <span className={styles.badge}>{RISK_LABEL[requested.risk]}</span>
      </p>
      {NON_ASCII.test(requested.tool) && (
        <p className={styles.denied} role="note">
          This tool name contains non-ASCII characters (shown escaped). It may imitate another
          tool&apos;s name.
        </p>
      )}
      <ul id={`${ids}-why`} className={styles.approvalReasons}>
        {requested.reasons.map((r) => (
          <li key={`${r.stage}:${r.code}:${r.rule_id ?? ""}`}>{r.message}</li>
        ))}
      </ul>
    </>
  );
}

/** The exact input, or why it is not here yet (a resumed run reads it back first). */
export function InputPreview({
  tool,
  input,
  state,
  onRetry,
}: {
  readonly tool: string;
  readonly input: unknown;
  readonly state: "ready" | "loading" | "failed";
  onRetry(): void;
}) {
  if (state === "ready") return <ApprovedInput tool={tool} input={input} />;
  if (state === "loading") {
    return (
      <p className={styles.hint} role="status">
        Loading the exact input…
      </p>
    );
  }
  return (
    <p className={styles.errorText} role="alert">
      The input could not be loaded, so it can&apos;t be approved yet.{" "}
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}
