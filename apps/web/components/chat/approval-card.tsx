"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KobeEventPayload } from "@kobe/protocol";
import type { ApiError } from "../../lib/api/client";
import type { ChatApi } from "../../lib/chat/api";
import { visible } from "../../lib/security/visible";
import { AdminChange, ApprovalTitle, InputPreview } from "./approval-card-parts";
import { GitChange } from "./git-approval";
import { RememberControls, askedForUnattendedRun, type RememberChoice } from "./approval-remember";
import { useApprovalInput, useRememberOptions } from "./use-approval-card";
import styles from "./chat.module.css";

type Requested = KobeEventPayload<"approval.requested">;
type Resolved = KobeEventPayload<"approval.resolved">;

const EXPIRED_TEXT: Record<Exclude<Resolved["cause"], "user">, string> = {
  ttl: "The approval request expired after 1 hour without an answer. The tool did not run.",
  run_cancelled: "The run was stopped before you answered. The tool did not run.",
  run_interrupted: "The run was interrupted before you answered. The tool did not run.",
  budget_exhausted: "The budget is used up, so the request expired. The tool did not run.",
  run_failed: "The run failed before you answered. The tool did not run.",
};

/** What the card says once the request is answered (the stream's `approval.resolved`). */
export function resolvedText(resolved: Resolved): string {
  if (resolved.decision === "allowed") {
    return resolved.remembered
      ? "Approved and remembered. You can revoke it in My area, Approvals."
      : "Approved.";
  }
  if (resolved.decision === "denied") return "Denied. The tool did not run.";
  return EXPIRED_TEXT[resolved.cause === "user" ? "run_interrupted" : resolved.cause];
}

export { visible };
export { pretty } from "./approval-card-parts";

/** Smooth unless the member asked for less motion. */
function scrollBehavior(): ScrollBehavior {
  const reduce =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduce ? "auto" : "smooth";
}

/** The message list follows the latest message (KOBE-288's `data-kobe-follow`, use-follow.ts). */
function followsLatest(el: Element): boolean {
  return el.closest("[data-kobe-follow]")?.getAttribute("data-kobe-follow") === "pinned";
}

/** Brings the first approval still waiting into view (the steering panel's Show button). */
export function scrollToPendingApproval(root: ParentNode = document): void {
  root
    .querySelector<HTMLElement>('[data-kobe-approval="pending"]')
    ?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The approval card (spec U6, D29): tool, the exact input that will run, risk, why it needs
 * approval, when it expires; Allow / Deny, "remember" (a rule for exactly this tool with a scope,
 * optionally only this exact action; KOBE-289) and "Approve all waiting" when several calls of the
 * run wait. The choices come from the server (`GET /v1/approvals/{id}/remember`), which applies the
 * team's limits; the server decides who may answer and signs every approval. This card only asks
 * and then waits for `approval.resolved`.
 */
export function ApprovalCard({
  requested,
  resolved,
  api,
  now = () => Date.now(),
  readOnly = false,
}: {
  readonly requested: Requested;
  readonly resolved: Resolved | undefined;
  readonly api:
    | (Pick<ChatApi, "decideApproval" | "getApproval"> &
        Partial<Pick<ChatApi, "rememberOptions" | "approveAll">>)
    | undefined;
  readonly now?: () => number;
  /** The viewer reads a thread shared with them: the run's user decides, not them. */
  readonly readOnly?: boolean;
}) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [sent, setSent] = useState<"allow" | "deny" | null>(null);
  const [choice, setChoice] = useState<RememberChoice>({
    remember: false,
    scope: undefined,
    exact: false,
  });
  const [confirmAll, setConfirmAll] = useState(false);
  const approvalId = requested.approval_id;
  const card = useRef<HTMLElement>(null);
  // A Kobe admin write (KOBE-623): never remembered, never in "Approve all waiting".
  const admin = requested.admin;
  const expired = Date.parse(requested.expires_at) <= now();
  const askable = resolved === undefined && !expired && !readOnly;
  // A request that arrives is brought into view once (KOBE-301), only while the list follows the
  // latest message: a member reading further up keeps their place (KOBE-288), and the steering
  // panel's Show brings it when they choose. Never for a reader, who cannot decide it.
  useEffect(() => {
    const el = card.current;
    if (askable && el !== null && followsLatest(el)) {
      el.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
    }
  }, [approvalId, askable]);
  const options = useRememberOptions(api, approvalId, askable, admin);
  const { input, inputState, retry } = useApprovalInput(
    api,
    approvalId,
    requested.input,
    resolved !== undefined,
  );

  if (resolved) {
    return (
      <p className={resolved.decision === "allowed" ? styles.notice : styles.denied} role="note">
        {resolvedText(resolved)}
      </p>
    );
  }
  // Every unicode-escaped character of the name, so lookalikes can't pass for another tool.
  const toolShown = visible(requested.tool).replace(
    /[^\x20-\x7e]/gu,
    (ch) => `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
  // Destructive tools are never remembered (the server refuses it as well).
  const canRemember =
    admin === undefined &&
    requested.risk !== "destructive" &&
    options?.canRemember === true &&
    options.choices.length > 0;
  const scope = choice.scope ?? options?.choices[0]?.scope;
  const exact = options?.exactOnly === true || choice.exact;
  const decide = async (decision: "allow" | "deny") => {
    if (!api) return;
    setBusy(true);
    setError(null);
    const res = await api.decideApproval(approvalId, {
      decision,
      ...(decision === "allow" && choice.remember && canRemember && scope !== undefined
        ? {
            remember: {
              toolGlob: requested.tool,
              scope,
              ...(exact && options.exact !== null ? { exact: true } : {}),
            },
          }
        : {}),
    });
    setBusy(false);
    if (res.ok) setSent(decision);
    else setError(res.error);
  };
  const waiting = admin === undefined ? (options?.approveAll?.approvalIds ?? []) : [];
  const approveAll = async () => {
    if (!api?.approveAll || options === undefined || waiting.length < 2) return;
    setBusy(true);
    setError(null);
    const res = await api.approveAll(options.runId, waiting);
    setBusy(false);
    setConfirmAll(false);
    if (res.ok) setSent("allow");
    else setError(res.error);
  };

  return (
    <section
      ref={card}
      className={`${styles.approval} kobe-panel`}
      role="group"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-why`}
      data-kobe-approval={expired || sent ? "answered" : "pending"}
    >
      <ApprovalTitle ids={ids} requested={requested} toolShown={toolShown} />
      {admin !== undefined && <AdminChange admin={admin} input={input} />}
      {requested.git !== undefined && <GitChange git={requested.git} />}
      <p className={styles.who}>Exactly this input runs if you allow it:</p>
      <InputPreview tool={requested.tool} input={input} state={inputState} onRetry={retry} />
      {expired ? (
        <p className={styles.denied} role="note">
          This approval request expired. The tool did not run.
        </p>
      ) : sent ? (
        <p className={styles.notice} role="status">
          {sent === "allow" ? "Approved. Waiting for the tool to run…" : "Denied."}
        </p>
      ) : (
        <>
          {options !== undefined && admin === undefined && requested.risk !== "destructive" && (
            <RememberControls
              options={options}
              toolShown={toolShown}
              value={{ ...choice, scope }}
              onChange={setChoice}
              disabled={busy}
              unattendedSibling={askedForUnattendedRun(requested.reasons)}
            />
          )}
          <div className={styles.approvalActions}>
            <button
              type="button"
              onClick={() => void decide("allow")}
              disabled={busy || !api || inputState !== "ready"}
            >
              Allow
            </button>
            <button type="button" onClick={() => void decide("deny")} disabled={busy || !api}>
              Deny
            </button>
            {waiting.length >= 2 && api?.approveAll && !confirmAll && (
              <button type="button" onClick={() => setConfirmAll(true)} disabled={busy}>
                Approve all waiting ({waiting.length})
              </button>
            )}
            <span className={styles.hint}>Expires at {timeOf(requested.expires_at)}</span>
          </div>
          {confirmAll && (
            <div className={styles.approvalRemember} role="group" aria-label="Approve all waiting">
              <p className={styles.who}>
                Allow all {waiting.length} calls waiting in this run? Each runs exactly as shown on
                its own card, and each is signed and recorded separately.
              </p>
              <button type="button" onClick={() => void approveAll()} disabled={busy}>
                Allow all {waiting.length}
              </button>{" "}
              <button type="button" onClick={() => setConfirmAll(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          )}
          {error && (
            <p className={styles.errorText} role="alert">
              {error.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
