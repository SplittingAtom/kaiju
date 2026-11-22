"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ApiResult } from "../../lib/api/client";
import type { MemoryItem, MemoryItemsApi, Overrides } from "../../lib/memory/items-api";
import { visible } from "../../lib/security/visible";
import { Notice } from "../ui/console";
import { CheckProblem, itemAnchor, useCheckedSave } from "./item-checks";
import { draftError, parseTags, type Draft } from "./item-fields";
import { editButtonId, pinButtonId, policyButtonId } from "./item-row-ids";
import { ItemActions, ItemEditForm, ItemSummary } from "./item-row-parts";

/** A change that was made, as the Undo bar shows it. */
export interface Done {
  readonly message: string;
  readonly undo?: (overrides: Overrides) => Promise<ApiResult<MemoryItem>>;
}

/** Names a row's buttons: the statement's start, as plain text. */
export const shortName = (statement: string) => {
  const text = visible(statement.replace(/\s+/g, " ").trim());
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

export { editButtonId, pinButtonId, policyButtonId } from "./item-row-ids";

const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * How an edit is undone: a statement-only edit by copying the version before it (revert);
 * anything else by setting the fields back.
 */
function editUndo(
  api: MemoryItemsApi,
  before: MemoryItem,
  after: MemoryItem,
  changed: {
    readonly statementChanged: boolean;
    readonly kindChanged: boolean;
    readonly tagsChanged: boolean;
  },
): NonNullable<Done["undo"]> {
  const { statementChanged, kindChanged, tagsChanged } = changed;
  return statementChanged && !kindChanged && !tagsChanged
    ? (o) => api.revert(after, before.version, after.version, o)
    : (o) =>
        api.patch(
          after,
          {
            expectedVersion: after.version,
            ...(statementChanged ? { statement: before.statement } : {}),
            ...(kindChanged ? { kind: before.kind } : {}),
            ...(tagsChanged ? { tags: before.tags } : {}),
          },
          o,
        );
}

/** Where focus goes once the lists show a change: an element id, or the row's group heading. */
export type FocusAfter = string | "group" | "archive";

/**
 * One memory: its statement (plain text, hidden characters escaped), kind, tags and pin, with
 * Edit, Pin and Archive (Restore when archived). Every change goes through the save checks; the
 * server's answer goes to `onChanged` with a way back for the Undo bar and where focus goes next.
 * A version conflict keeps the draft: Reload shows the saved text beside it and saves over it.
 */
export function ItemRow({
  item,
  api,
  known,
  onChanged,
  onRefreshed,
  readOnly = false,
  canSetPolicy = false,
  extra,
}: {
  readonly item: MemoryItem;
  readonly api: MemoryItemsApi;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly onChanged: (item: MemoryItem, done: Done, focus: FocusAfter) => void;
  /** The item as saved now (Reload after a conflict); no Undo. */
  readonly onRefreshed: (item: MemoryItem) => void;
  /** Shown without actions (a member, or a scope the caller doesn't curate; KOBE-385). */
  readonly readOnly?: boolean;
  /**
   * The caller sets Policy (Site admins, `site.memory.policy`): a Site item gets the Policy
   * toggle. Without it a Policy item is read-only (Site stewards never change Policy).
   */
  readonly canSetPolicy?: boolean;
  /** More for an active row the caller acts on (Propose to Site on Workspace memories, KOBE-404). */
  readonly extra?: ReactNode;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The version the draft started from; a newer `item.version` means someone saved meanwhile. */
  const [base, setBase] = useState(item.version);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const { busy, problem, save, clear } = useCheckedSave();
  const name = shortName(item.statement);
  const archived = item.status !== "active";
  const moved = draft !== null && item.version !== base;
  // No actions: read-only callers, superseded history, and Policy for anyone who can't set it.
  const locked = readOnly || item.status === "superseded" || (item.policy && !canSetPolicy);
  // A Site memory shown to someone who doesn't curate it here (My memory, the Workspace console)
  // says who set it, and never where it came from (KOBE-670; KOBE-403 provenance rules).
  const setBySite = item.scope === "site" && readOnly;

  /** Cancel: back to Edit once the form is gone. */
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus || draft !== null) return;
    document.getElementById(editButtonId(item.id))?.focus();
    setRefocus(false);
  }, [refocus, draft, item.id]);

  const close = () => {
    clear();
    setDraft(null);
    setRefocus(true);
  };

  const startEdit = () => {
    clear();
    setInvalid(null);
    setBase(item.version);
    setDraft({ statement: item.statement, kind: item.kind, tags: item.tags.join(", ") });
  };

  const reload = async () => {
    setReloadError(null);
    const res = await api.get(item.scope, item.id);
    if (!res.ok) return setReloadError(res.error.message);
    clear();
    onRefreshed(res.data);
  };

  const submitEdit = () => {
    if (draft === null) return;
    const bad = draftError(draft);
    setInvalid(bad);
    if (bad) return;
    const tags = parseTags(draft.tags);
    const statementChanged = draft.statement !== item.statement;
    const kindChanged = draft.kind !== item.kind;
    const tagsChanged = !sameTags(tags, item.tags);
    if (!statementChanged && !kindChanged && !tagsChanged) return close();
    const before = item;
    void save(
      (o) =>
        api.patch(
          before,
          {
            expectedVersion: before.version,
            ...(statementChanged ? { statement: draft.statement } : {}),
            ...(kindChanged ? { kind: draft.kind } : {}),
            ...(tagsChanged ? { tags } : {}),
          },
          o,
        ),
      (after) => {
        setDraft(null);
        onChanged(
          after,
          {
            message: "Memory saved.",
            undo: editUndo(api, before, after, { statementChanged, kindChanged, tagsChanged }),
          },
          editButtonId(after.id),
        );
      },
    );
  };

  const togglePin = () =>
    void save(
      () => api.pin(item, !item.pinned),
      (after) =>
        onChanged(
          after,
          {
            message: after.pinned ? "Pinned." : "Unpinned.",
            undo: () => api.pin(after, !after.pinned),
          },
          pinButtonId(after.id),
        ),
    );

  const togglePolicy = () =>
    void save(
      () => api.patch(item, { expectedVersion: item.version, policy: !item.policy }),
      (after) =>
        onChanged(
          after,
          {
            message: after.policy ? "Made Policy." : "No longer Policy.",
            undo: () => api.patch(after, { expectedVersion: after.version, policy: !after.policy }),
          },
          policyButtonId(after.id),
        ),
    );

  const archive = () =>
    void save(
      () => api.archive(item),
      (after) =>
        onChanged(after, { message: "Archived.", undo: (o) => api.restore(after, o) }, "group"),
    );

  const restore = () =>
    void save(
      (o) => api.restore(item, o),
      (after) =>
        onChanged(after, { message: "Restored.", undo: () => api.archive(after) }, "archive"),
    );

  return (
    <li
      id={itemAnchor(item.id)}
      tabIndex={-1}
      aria-label={name}
      className="box-border rounded-md border border-console-border p-3 focus:outline-2 focus:outline-console-accent"
    >
      {draft === null ? (
        <>
          <ItemSummary item={item} setBySite={setBySite} />
          {!locked && (
            <ItemActions
              item={item}
              name={name}
              busy={busy}
              canSetPolicy={canSetPolicy}
              startEdit={startEdit}
              togglePin={togglePin}
              togglePolicy={togglePolicy}
              archive={archive}
              restore={restore}
            />
          )}
          {!locked && !archived && extra}
        </>
      ) : (
        <ItemEditForm
          item={item}
          name={name}
          draft={draft}
          moved={moved}
          invalid={invalid}
          busy={busy}
          setDraft={setDraft}
          submitEdit={submitEdit}
          close={close}
        />
      )}
      {problem && (
        <CheckProblem problem={problem} known={known} busy={busy} onReload={() => void reload()} />
      )}
      {reloadError && (
        <Notice tone="error">
          <p>{reloadError}</p>
        </Notice>
      )}
    </li>
  );
}
