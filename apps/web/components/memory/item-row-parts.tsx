"use client";

import { SET_BY_SITE, type MemoryItem } from "../../lib/memory/items-api";
import { visible } from "../../lib/security/visible";
import { Badge, Button, Notice } from "../ui/console";
import { DraftFields, KIND_LABELS, type Draft } from "./item-fields";
import { editButtonId, pinButtonId, policyButtonId } from "./item-row-ids";

/** A memory as read: its statement (plain text, hidden characters escaped), kind, marks and tags. */
export function ItemSummary({
  item,
  setBySite,
}: {
  readonly item: MemoryItem;
  readonly setBySite: boolean;
}) {
  const archived = item.status !== "active";
  return (
    <>
      <p className="m-0 [overflow-wrap:anywhere] whitespace-pre-wrap">{visible(item.statement)}</p>
      <p className="m-0 mt-2 flex flex-wrap items-center gap-1 text-sm text-console-muted">
        <span>{KIND_LABELS[item.kind]}</span>
        {setBySite && <Badge>{SET_BY_SITE}</Badge>}
        {item.pinned && <Badge tone="accent">Pinned</Badge>}
        {item.policy && <Badge tone="accent">Policy</Badge>}
        {archived && <Badge>{item.status === "superseded" ? "Superseded" : "Archived"}</Badge>}
        {item.tags.map((t) => (
          <Badge key={t}>{visible(t)}</Badge>
        ))}
      </p>
    </>
  );
}

/** Edit, Pin, Policy (Site items, for those who set it) and Archive; Restore when archived. */
export function ItemActions({
  item,
  name,
  busy,
  canSetPolicy,
  startEdit,
  togglePin,
  togglePolicy,
  archive,
  restore,
}: {
  readonly item: MemoryItem;
  readonly name: string;
  readonly busy: boolean;
  readonly canSetPolicy: boolean;
  startEdit(): void;
  togglePin(): void;
  togglePolicy(): void;
  archive(): void;
  restore(): void;
}) {
  const archived = item.status !== "active";
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {archived ? (
        <Button size="sm" disabled={busy} aria-label={`Restore: ${name}`} onClick={restore}>
          Restore
        </Button>
      ) : (
        <>
          <Button
            id={editButtonId(item.id)}
            size="sm"
            disabled={busy}
            aria-label={`Edit: ${name}`}
            onClick={startEdit}
          >
            Edit
          </Button>
          {!item.policy && (
            <Button
              id={pinButtonId(item.id)}
              size="sm"
              disabled={busy}
              aria-label={`Pin: ${name}`}
              aria-pressed={item.pinned}
              onClick={togglePin}
            >
              Pin
            </Button>
          )}
          {item.scope === "site" && canSetPolicy && !item.pinned && (
            <Button
              id={policyButtonId(item.id)}
              size="sm"
              disabled={busy}
              aria-label={`Policy: ${name}`}
              aria-pressed={item.policy}
              onClick={togglePolicy}
            >
              Policy
            </Button>
          )}
          <Button size="sm" disabled={busy} aria-label={`Archive: ${name}`} onClick={archive}>
            Archive
          </Button>
        </>
      )}
    </div>
  );
}

/** The edit form: the draft, the version saved meanwhile beside it, and why the draft is refused. */
export function ItemEditForm({
  item,
  name,
  draft,
  moved,
  invalid,
  busy,
  setDraft,
  submitEdit,
  close,
}: {
  readonly item: MemoryItem;
  readonly name: string;
  readonly draft: Draft;
  readonly moved: boolean;
  readonly invalid: string | null;
  readonly busy: boolean;
  setDraft(draft: Draft): void;
  submitEdit(): void;
  close(): void;
}) {
  return (
    <form
      aria-label={`Editing: ${name}`}
      onSubmit={(e) => {
        e.preventDefault();
        submitEdit();
      }}
    >
      {moved && (
        <Notice tone="info" title={`Saved now (version ${item.version})`}>
          <p data-testid="saved-now" className="[overflow-wrap:anywhere] whitespace-pre-wrap">
            {visible(item.statement)}
          </p>
          <p>Your draft is kept below. Save replaces the saved text with it.</p>
        </Notice>
      )}
      <DraftFields
        draft={draft}
        onChange={setDraft}
        label="Memory text"
        preferenceOnly={item.scope === "portable"}
        autoFocus
      />
      {invalid && (
        <p role="alert" className="m-0 mt-2 text-sm text-status-failed">
          {invalid}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          Save
        </Button>
        <Button size="sm" disabled={busy} onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
