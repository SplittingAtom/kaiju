"use client";

import { useId, useState } from "react";
import type { ItemKind } from "../../../lib/memory/items-api";
import type { ProposalsApi, Proposed } from "../../../lib/memory/proposals-api";
import {
  SITE_JUSTIFICATION_MAX,
  type SiteProposalsApi,
  type SiteProposed,
} from "../../../lib/memory/site-proposals-api";
import { Button, ChoiceGroup, Field, Radio, Textarea } from "../../ui/console";

const NOTE_MAX = 1000;

type Target = "workspace" | "site";

/** Where Propose… can send a candidate; absent: not offered to this person. */
export interface ProposeTargets {
  /** To the Workspace's curators (KOBE-397): members who don't curate, for a shareable memory. */
  readonly workspace?: {
    readonly api: Pick<ProposalsApi, "propose">;
    readonly onProposed: (proposed: Proposed) => void;
  };
  /**
   * To the Site (KOBE-404, SM19): anyone, but only for a new memory the person stated or
   * confirmed. `refusal` says why not (the option shows disabled with it).
   */
  readonly site?: {
    readonly api: Pick<SiteProposalsApi, "proposeCandidate">;
    readonly refusal: string | null;
    readonly onProposed: (proposed: SiteProposed) => void;
  };
}

/**
 * Propose… on a To review card: sends the candidate as shown (with the card's edits) to the
 * Workspace's curators with an optional note (their words go with it; KOBE-397), or to the Site
 * with a required justification (only the statement and the justification leave the Workspace,
 * after a Team admin confirms; KOBE-404). Nothing is saved until someone decides.
 */
export function ProposeAction({
  candidateId,
  original,
  draft,
  targets,
  disabled = false,
}: {
  readonly candidateId: string;
  readonly original: { readonly statement: string; readonly kind: ItemKind };
  readonly draft: { readonly statement: string; readonly kind: ItemKind };
  readonly targets: ProposeTargets;
  readonly disabled?: boolean;
}) {
  const name = useId();
  const { workspace, site } = targets;
  const siteOpen = site !== undefined && site.refusal === null;
  const [open, setOpen] = useState(false);
  const initial: Target | null = workspace ? "workspace" : siteOpen ? "site" : null;
  const [target, setTarget] = useState<Target | null>(initial);
  const [note, setNote] = useState("");
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!workspace && !site) return null;
  if (!open)
    return (
      <Button disabled={disabled} aria-expanded={false} onClick={() => setOpen(true)}>
        Propose…
      </Button>
    );

  const edits = {
    ...(draft.statement === original.statement ? {} : { statement: draft.statement }),
    ...(draft.kind === original.kind ? {} : { kind: draft.kind }),
  };

  async function send() {
    if (draft.statement.trim() === "") return setError("Write the memory first.");
    if (target === "site" && justification.trim() === "")
      return setError("Say why every workspace should know this.");
    setBusy(true);
    setError(null);
    if (target === "site" && site) {
      const res = await site.api.proposeCandidate(candidateId, {
        ...edits,
        justification: justification.trim(),
      });
      setBusy(false);
      if (res.ok) site.onProposed(res.data);
      else setError(res.error.message);
      return;
    }
    if (!workspace) return setBusy(false);
    const res = await workspace.api.propose(candidateId, {
      ...edits,
      ...(note.trim() === "" ? {} : { rationale: note.trim() }),
    });
    setBusy(false);
    if (res.ok) workspace.onProposed(res.data);
    else setError(res.error.message);
  }

  const choose = (t: Target) => {
    setTarget(t);
    setError(null);
  };

  return (
    <div
      role="group"
      aria-label="Propose"
      className="flex w-full flex-col gap-2 rounded border border-console-border p-3"
    >
      {site && (
        <ChoiceGroup legend="Propose to" stacked>
          {workspace && (
            <Radio
              name={name}
              label="This Workspace's curators"
              checked={target === "workspace"}
              onChange={() => choose("workspace")}
            />
          )}
          <Radio
            name={name}
            label="The Site (every workspace)"
            checked={target === "site"}
            disabled={!siteOpen}
            hint={site.refusal ?? undefined}
            onChange={() => choose("site")}
          />
        </ChoiceGroup>
      )}
      {target === "workspace" && (
        <>
          <p className="m-0 text-sm">
            Team admins and memory stewards decide. They see the statement, your note and your words
            from this conversation. Proposals wait up to 30 days.
          </p>
          <Field label="Note for the curators (optional)" hint={`At most ${NOTE_MAX} characters.`}>
            <Textarea
              value={note}
              maxLength={NOTE_MAX}
              rows={2}
              autoFocus={initial === "workspace"}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </>
      )}
      {target === "site" && (
        <>
          <p className="m-0 text-sm">
            A Team admin of this workspace confirms it first, then the Site&apos;s admins and memory
            stewards decide. Only the statement and your reason leave this workspace: never your
            words from this conversation. Proposals wait up to 30 days.
          </p>
          <Field
            label="Why every workspace should know this"
            hint={`Required. At most ${SITE_JUSTIFICATION_MAX} characters.`}
            required
          >
            <Textarea
              value={justification}
              maxLength={SITE_JUSTIFICATION_MAX}
              rows={2}
              // Focus moves here only when the form opens on it: never while arrowing the radios.
              autoFocus={initial === "site"}
              onChange={(e) => setJustification(e.target.value)}
            />
          </Field>
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-status-failed">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {target !== null && (
          <Button variant="primary" disabled={busy} onClick={() => void send()}>
            {target === "site" ? "Propose to the Site" : "Send to curators"}
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Why a candidate can't go to the Site (null: it can). The server's rule (KOBE-403): stated or
 * confirmed, a new memory, shareable with the Workspace.
 */
export function siteRefusal(candidate: {
  readonly source: "stated" | "confirmed" | "inferred";
  readonly operation: string;
  readonly allowedScopes: readonly string[];
}): string | null {
  if (candidate.source === "inferred")
    return "Kobe noticed this rather than you saying it: only what you said or confirmed goes to the Site.";
  if (candidate.operation !== "add" || !candidate.allowedScopes.includes("team"))
    return "Only a new memory everyone could share can be proposed to the Site.";
  return null;
}
