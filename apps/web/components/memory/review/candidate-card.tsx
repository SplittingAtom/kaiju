"use client";

import { useId, useState, type ReactNode } from "react";
import type { ItemKind, MemoryItem } from "../../../lib/memory/items-api";
import type {
  Candidate,
  ReviewApi,
  ReviewScope,
  SavedCandidate,
} from "../../../lib/memory/review-api";
import { visible } from "../../../lib/security/visible";
import { Button, Card, Checkbox, ChoiceGroup, Radio, useConfirm } from "../../ui/console";
import { CheckProblem, useCheckedSave } from "../item-checks";
import { DraftFields, draftError, type Draft } from "../item-fields";
import { CandidateContext, CandidateLabels, CandidateWhy } from "./candidate-details";
import { SCOPE_LABELS } from "./labels";

/** Actions later tickets plug in beside Save (absent: not offered). */
export interface CardSeams {
  /** Propose… to the Workspace's curators (KOBE-397). */
  readonly onPropose?: (candidate: Candidate) => void;
  /**
   * The project action in a project thread (KOBE-398: Add to project notes; readers' Suggest to
   * editors is KOBE-652): `project-notes-action.tsx`, given the statement as edited.
   */
  readonly projectNotes?: (candidate: Candidate, statement: string, kind: ItemKind) => ReactNode;
}

const NO_ITEMS: ReadonlyMap<string, MemoryItem> = new Map();

/** The scope a choice of place and "all my workspaces" makes. */
export function chosenScope(workspace: boolean, everywhere: boolean, kind: ItemKind): ReviewScope {
  if (workspace) return "team";
  return everywhere && kind === "preference" ? "portable" : "user";
}

/**
 * One candidate in To review (KOBE-396): the statement (editable), labels, why and evidence, the
 * diff or conflict it brings, the place (only the allowed ones; locked for inferred), the
 * portable choice behind a confirmation, and Save / Dismiss. The server checks every click again;
 * a refusal shows inline with Save anyway where the memory checks allow it.
 */
export function CandidateCard({
  candidate,
  api,
  threadId,
  canCurateWorkspace,
  onSaved,
  onDismissed,
  seams,
}: {
  readonly candidate: Candidate;
  readonly api: ReviewApi;
  readonly threadId: string;
  readonly canCurateWorkspace: boolean;
  readonly onSaved: (saved: SavedCandidate) => void;
  readonly onDismissed: (candidate: Candidate) => void;
  readonly seams?: CardSeams | undefined;
}) {
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    statement: candidate.statement,
    kind: candidate.kind,
    tags: "",
  });
  const [workspace, setWorkspace] = useState(candidate.scope === "team");
  const [everywhere, setEverywhere] = useState(candidate.scope === "portable");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const { busy, problem, save, clear } = useCheckedSave();

  const allowed = candidate.allowedScopes;
  const scope = chosenScope(workspace, everywhere, draft.kind);
  const mayWorkspace = !candidate.scopeLocked && allowed.includes("team");
  const mayEverywhere = !workspace && draft.kind === "preference" && candidate.operation === "add";
  const curatorOnly = scope === "team" && !canCurateWorkspace;

  async function submit(trigger: HTMLElement | null, policyConflict = false) {
    const bad = draftError(draft);
    setInvalid(bad);
    if (bad) return;
    if (scope === "portable") {
      const yes = await confirm(
        {
          title: "Use in all my workspaces?",
          description: (
            <>
              <span className="block">
                Kobe will use this preference in every workspace you belong to:
              </span>
              <span className="mt-2 block border-0 border-l-4 border-solid border-console-border ps-3 [overflow-wrap:anywhere] whitespace-pre-wrap">
                {visible(draft.statement)}
              </span>
            </>
          ),
          confirmLabel: "Use in all my workspaces",
          tone: "primary",
        },
        trigger,
      );
      if (!yes) return;
    }
    const edit = {
      ...(draft.statement === candidate.statement ? {} : { statement: draft.statement }),
      ...(draft.kind === candidate.kind ? {} : { kind: draft.kind }),
      // Portable always names its scope: the server needs the confirmation with it.
      ...(scope === candidate.scope && scope !== "portable" ? {} : { scope }),
    };
    let saved: SavedCandidate | null = null;
    await save(
      async (o) => {
        const res = await api.save(candidate.id, edit, o);
        if (!res.ok) return res;
        saved = res.data;
        return { ok: true, status: res.status, data: res.data.item };
      },
      () => {
        if (saved) onSaved(saved);
      },
      policyConflict ? { policyConflict: true } : {},
    );
  }

  async function dismiss() {
    setDismissError(null);
    const res = await api.dismiss(candidate.id);
    if (res.ok) onDismissed(candidate);
    else setDismissError(res.error.message);
  }

  return (
    <Card aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3
        id={headingId}
        tabIndex={-1}
        data-review-statement
        className="m-0 text-base font-semibold [overflow-wrap:anywhere]"
      >
        {visible(editing ? draft.statement : candidate.statement)}
      </h3>
      <CandidateLabels candidate={candidate} />
      {editing && (
        <DraftFields
          draft={draft}
          label="Statement"
          autoFocus
          onChange={(d) => {
            setDraft(d);
            if (problem) clear();
          }}
        />
      )}
      <CandidateWhy candidate={candidate} threadId={threadId} />
      <CandidateContext
        candidate={candidate}
        statement={draft.statement}
        busy={busy}
        {...(candidate.policyConflicts.length > 0
          ? { saveAnyway: () => void submit(null, true) }
          : {})}
      />
      <ChoiceGroup
        legend="Keep it for"
        hint={candidate.scopeLocked ? lockedHint(candidate) : undefined}
      >
        <Radio
          name={`scope-${candidate.id}`}
          label={SCOPE_LABELS.user}
          checked={!workspace}
          disabled={!mayWorkspace}
          onChange={() => {
            setWorkspace(false);
            if (problem) clear();
          }}
        />
        {(mayWorkspace || candidate.scope === "team") && (
          <Radio
            name={`scope-${candidate.id}`}
            label={SCOPE_LABELS.team}
            checked={workspace}
            disabled={!mayWorkspace}
            onChange={() => {
              setWorkspace(true);
              if (problem) clear();
            }}
          />
        )}
      </ChoiceGroup>
      {mayEverywhere && (
        <Checkbox
          label="Use in all my workspaces"
          hint="Preferences can follow you into every workspace you belong to."
          checked={everywhere}
          onChange={(e) => {
            setEverywhere(e.target.checked);
            if (problem) clear();
          }}
        />
      )}
      {curatorOnly && (
        <p className="m-0 text-sm text-console-muted">
          Only Team admins and memory stewards save Workspace memories. Keep it for yourself, or
          propose it when proposals are available.
        </p>
      )}
      {invalid && (
        <p role="alert" className="m-0 text-sm text-status-failed">
          {invalid}
        </p>
      )}
      {problem && (
        <CheckProblem problem={problem} known={NO_ITEMS} busy={busy} onReload={() => clear()} />
      )}
      {dismissError && (
        <p role="alert" className="m-0 text-sm text-status-failed">
          {dismissError}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy || curatorOnly}
          onClick={(e) => void submit(e.currentTarget)}
        >
          Save
        </Button>
        {curatorOnly && seams?.onPropose && (
          <Button onClick={() => seams?.onPropose?.(candidate)}>Propose…</Button>
        )}
        {seams?.projectNotes?.(candidate, draft.statement, draft.kind)}
        <Button variant="ghost" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
          {editing ? "Done editing" : "Edit"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
      {confirmDialog}
    </Card>
  );
}

function lockedHint(candidate: Candidate): string {
  if (candidate.operation !== "add")
    return "It changes a memory you already have, so it stays there.";
  return "Kobe noticed this rather than you saying it, so it stays yours.";
}
