"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ApiError, ApiResult } from "../../../lib/api/client";
import {
  decidePortableGrant,
  listPortableGrants,
  readPortableItems,
  requestPortableGrant,
  type PortableGrant,
  type PortableGrantDecision,
  type PortableGrantList,
  type PortableItem,
} from "../../../lib/admin/api/site/portable-break-glass";
import { listUsers, type SiteUser } from "../../../lib/admin/api/site/users";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormRow,
  Notice,
  PageHeader,
  Section,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  eventTrigger,
  useConfirm,
  type BadgeTone,
} from "../../ui/console";
import { ErrorNotice, MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { durationLabel } from "./break-glass-page";

interface PageData extends PortableGrantList {
  readonly people: readonly SiteUser[];
}

async function loadPage(): Promise<ApiResult<PageData>> {
  const [grants, people] = await Promise.all([listPortableGrants(), listUsers()]);
  if (!grants.ok) return grants;
  if (!people.ok) return people;
  return { ok: true, status: 200, data: { ...grants.data, people: people.data } };
}

const DURATIONS = [15, 30, 60, 120, 240, 480, 1440] as const;

const STATUS_LABELS = {
  pending: "Waiting for approval",
  active: "Active",
  denied: "Denied",
  revoked: "Revoked",
  expired: "Ended",
} as const;

const STATUS_TONES: Readonly<Record<PortableGrant["status"], BadgeTone>> = {
  pending: "attention",
  active: "running",
  denied: "neutral",
  revoked: "neutral",
  expired: "neutral",
};

/**
 * Break-glass for portable memories (KOBE-648, SM28; `/v1/site/portable-break-glass`). Portable
 * memories follow a person into every Workspace, so a Workspace grant can't reach them: a site
 * admin asks for time-boxed, read-only access to one person's portable memories with a reason; a
 * second site admin approves (a single-admin site self-approves, flagged). The person is told
 * (unless legal hold), and every read is recorded in the Site audit log and in the audit view of
 * each Workspace the person belongs to. The server and the database decide.
 */
export function PortableBreakGlassPage() {
  const { state, reload } = useResource(loadPage);
  const mutation = useMutation();
  const [reading, setReading] = useState<PortableGrant | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  async function decide(
    grant: PortableGrant,
    decision: PortableGrantDecision,
    trigger: HTMLElement | null,
  ) {
    const verbs = {
      approve: "Approve",
      deny: "Deny",
      revoke: grant.status === "pending" ? "Withdraw" : "Revoke",
    };
    const yes = await confirm(
      {
        title: `${verbs[decision]} access to ${grant.subject.name}'s portable memories?`,
        ...(grant.legalHold
          ? { description: "This is a legal hold: the person is not notified." }
          : {}),
        confirmLabel: verbs[decision],
        tone: decision === "approve" ? "primary" : "danger",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => decidePortableGrant(grant.id, decision),
      ({ grant: g }) => `${STATUS_LABELS[g.status]}: ${g.subject.name}.`,
    );
    if (done) {
      if (reading?.id === grant.id) setReading(null);
      reload();
    }
  }

  if (reading) {
    return (
      <PortableReader
        grant={reading}
        onClose={() => {
          setReading(null);
          reload();
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Portable memory access"
        description="Portable memories are the preferences that follow a person into every Workspace. Only their owner can read them. Break-glass gives one site admin read-only access to one person's portable memories for a limited time, after a second site admin approves. The person is notified, and every read is recorded in the Site audit log and in each of their Workspaces' audit views. A person's Workspace memories stay under Workspace break-glass."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="portable memory grants">
        {(data) => (
          <>
            <RequestForm
              people={data.people}
              soleAdmin={data.selfApprovalAllowed}
              mutation={mutation}
              onRequested={reload}
            />
            <Section title="Requests and grants">
              <GrantTable
                grants={data.grants}
                onDecide={(g, decision, trigger) => void decide(g, decision, trigger)}
                onRead={setReading}
                pending={mutation.pending}
              />
            </Section>
          </>
        )}
      </ResourceView>
      {confirmDialog}
    </>
  );
}

type Mutation = ReturnType<typeof useMutation>;

function RequestForm({
  people,
  soleAdmin,
  mutation,
  onRequested,
}: {
  readonly people: readonly SiteUser[];
  readonly soleAdmin: boolean;
  readonly mutation: Mutation;
  readonly onRequested: () => void;
}) {
  const [subjectUserId, setSubject] = useState("");
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState(60);
  const [legalHold, setLegalHold] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () =>
        requestPortableGrant({
          subjectUserId,
          reason: reason.trim(),
          durationMinutes: duration,
          legalHold,
        }),
      ({ grant: g }) =>
        soleAdmin
          ? `Requested access to ${g.subject.name}'s portable memories. You can approve it yourself (it will be flagged).`
          : `Requested access to ${g.subject.name}'s portable memories. A second site admin must approve it.`,
    );
    if (done) {
      setSubject("");
      setReason("");
      setLegalHold(false);
      onRequested();
    }
  }

  return (
    <Section title="Request access">
      <form onSubmit={onSubmit} aria-label="Request access to portable memories">
        <FormRow className="mt-0">
          <Field label="Person">
            <Select required value={subjectUserId} onChange={(e) => setSubject(e.target.value)}>
              <option value="">Choose a person…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.email}){p.deactivatedAt ? " – deactivated" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Duration">
            <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {durationLabel(d)}
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>
        <Field label="Reason" className="mb-3 max-w-2xl">
          <Textarea
            required
            minLength={10}
            maxLength={2000}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Checkbox
          className="mb-3"
          label="Legal hold (don't notify the person being investigated)"
          checked={legalHold}
          onChange={(e) => setLegalHold(e.target.checked)}
        />
        <div>
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            Request access
          </Button>
        </div>
      </form>
    </Section>
  );
}

function GrantTable({
  grants,
  onDecide,
  onRead,
  pending,
}: {
  readonly grants: readonly PortableGrant[];
  readonly onDecide: (
    grant: PortableGrant,
    decision: PortableGrantDecision,
    trigger: HTMLElement | null,
  ) => void;
  readonly onRead: (grant: PortableGrant) => void;
  readonly pending: boolean;
}) {
  if (grants.length === 0) return <EmptyState title="No requests for portable memories yet." />;
  return (
    <Table caption="Requests and grants" hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Person</TableHeader>
          <TableHeader>Requested by</TableHeader>
          <TableHeader>Reason</TableHeader>
          <TableHeader>Status</TableHeader>
          <TableHeader>Window</TableHeader>
          <TableHeader>
            <span className="sr-only">Actions</span>
          </TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {grants.map((g) => (
          <TableRow key={g.id}>
            <TableCell>
              {g.subject.name}
              {g.legalHold && (
                <>
                  <br />
                  <strong>Legal hold:</strong> the person is not notified
                </>
              )}
            </TableCell>
            <TableCell>
              {g.requestedBy.name}
              <br />
              <span className="text-sm text-console-muted">
                <DateTime value={g.requestedAt} />
              </span>
            </TableCell>
            <TableCell>{g.reason}</TableCell>
            <TableCell>
              <Badge tone={STATUS_TONES[g.status]}>{STATUS_LABELS[g.status]}</Badge>
              {g.approvedBy && (
                <>
                  <br />
                  <span className="text-sm text-console-muted">
                    {g.selfApproved
                      ? `Self-approved by ${g.approvedBy.name} (flagged)`
                      : `Approved by ${g.approvedBy.name}`}
                  </span>
                </>
              )}
            </TableCell>
            <TableCell>
              {g.startsAt ? (
                <>
                  <DateTime value={g.startsAt} /> – <DateTime value={g.endedAt ?? g.expiresAt} />
                </>
              ) : (
                durationLabel(g.durationMinutes)
              )}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1.5">
                {g.actions.read && (
                  <Button size="sm" variant="primary" onClick={() => onRead(g)}>
                    Read
                  </Button>
                )}
                {g.actions.approve && (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={(e) => onDecide(g, "approve", eventTrigger(e))}
                  >
                    Approve
                  </Button>
                )}
                {g.actions.deny && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={pending}
                    onClick={(e) => onDecide(g, "deny", eventTrigger(e))}
                  >
                    Deny
                  </Button>
                )}
                {g.actions.revoke && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={pending}
                    onClick={(e) => onDecide(g, "revoke", eventTrigger(e))}
                  >
                    {g.status === "pending" ? "Withdraw" : "Revoke"}
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Read-only list of the person's portable memories under an active grant. Each page load is a
 * separate, audited read; the server re-checks the grant every time.
 */
export function PortableReader({
  grant,
  onClose,
}: {
  readonly grant: PortableGrant;
  readonly onClose: () => void;
}) {
  const [items, setItems] = useState<readonly PortableItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [workspaces, setWorkspaces] = useState<number | null>(null);

  async function load(after: string | null) {
    const res = await readPortableItems(grant.id, after);
    if (!res.ok) return setError(res.error);
    setError(null);
    setWorkspaces(res.data.grant.workspaces);
    setItems((prev) => (after ? [...prev, ...res.data.items] : res.data.items));
    setNext(res.data.nextAfter);
  }

  useEffect(() => {
    void load(null);
    // Load once per grant; later pages are explicit clicks.
  }, [grant.id]);

  return (
    <>
      <PageHeader
        title={`${grant.subject.name}'s portable memories`}
        description="Read-only. Every page you open is recorded in the Site audit log and in the audit view of each Workspace this person belongs to."
      />
      <div className="mb-3">
        <Button onClick={onClose}>Back to requests</Button>
      </div>
      {grant.expiresAt && (
        <Notice tone="warn" role="note">
          Access ends <DateTime value={grant.expiresAt} />.
          {workspaces !== null && ` Recorded in ${workspaces} Workspace audit view(s).`}
        </Notice>
      )}
      {error && <ErrorNotice error={error} />}
      <Section title="Portable memories">
        {items.length === 0 && !error ? (
          <EmptyState title="No portable memories." />
        ) : (
          <Table caption="Portable memories" hideCaption>
            <TableHead>
              <TableRow>
                <TableHeader>Memory</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Tags</TableHeader>
                <TableHeader>Updated</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.statement}</TableCell>
                  <TableCell>
                    {i.status}
                    {i.pinned ? " (pinned)" : ""}
                  </TableCell>
                  <TableCell>{i.tags.join(", ")}</TableCell>
                  <TableCell>
                    <DateTime value={i.updatedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {next && <Button onClick={() => void load(next)}>Load more</Button>}
      </Section>
    </>
  );
}
