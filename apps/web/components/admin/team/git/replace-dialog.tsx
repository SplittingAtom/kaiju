"use client";

import { useRef, useState, type FormEvent } from "react";
import {
  replaceGitCredential,
  type GitAdminConnection,
  type GitCredentialKind,
  type GitReport,
  type GitSaved,
} from "../../../../lib/admin/api/team/git";
import { gitErrorMessage, insufficientReport } from "../../../../lib/admin/git/errors";
import { providerName } from "../../../../lib/admin/git/labels";
import { Button, Dialog, DialogClose, Notice } from "../../../ui/console";
import { CredentialFields, type CredentialHandle } from "./credential-fields";
import { PermissionsHelp } from "./permissions-help";
import { TestReportView } from "./test-report";

/**
 * Replace credential (G8): the new token or key is tested on the host before it is stored; the
 * old one is overwritten. The secret is read from its field at submit and wiped on success; the
 * fields unmount (and drop it) when the dialog closes.
 */
export function ReplaceCredentialDialog({
  open,
  onOpenChange,
  teamId,
  connection,
  returnFocus,
  onReplaced,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly teamId: string;
  readonly connection: GitAdminConnection;
  readonly returnFocus: () => HTMLElement | null;
  readonly onReplaced: (saved: GitSaved) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Replace the credential of ${connection.displayName}`}
      description="Kobe tests the new credential before it replaces the old one, which is then discarded."
      returnFocus={returnFocus}
    >
      {open ? (
        <ReplaceForm
          teamId={teamId}
          connection={connection}
          onReplaced={(saved) => {
            onReplaced(saved);
            onOpenChange(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function ReplaceForm({
  teamId,
  connection: c,
  onReplaced,
}: {
  readonly teamId: string;
  readonly connection: GitAdminConnection;
  readonly onReplaced: (saved: GitSaved) => void;
}) {
  const credential = useRef<CredentialHandle>(null);
  const [kind, setKind] = useState<GitCredentialKind>(c.credential.kind);
  const [failure, setFailure] = useState<{ message: string; report?: GitReport } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cred = credential.current?.read() ?? null;
    if (!cred) return;
    setPending(true);
    setFailure(null);
    try {
      const res = await replaceGitCredential(teamId, c.id, cred);
      if (res.ok) {
        credential.current?.clear();
        onReplaced(res.data);
        return;
      }
      const report = insufficientReport(res.error);
      setFailure({
        message: gitErrorMessage(res.error, undefined, {
          organization: c.organization,
          providerLabel: providerName(c.provider, c.baseUrl),
        }),
        ...(report ? { report } : {}),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form noValidate aria-label="Replace credential" onSubmit={(e) => void submit(e)}>
      <div className="flex flex-col gap-3">
        <CredentialFields
          ref={credential}
          provider={c.provider}
          kind={kind}
          onKindChange={setKind}
          onEdited={() => setFailure(null)}
          disabled={pending}
        />
        <PermissionsHelp
          provider={c.provider}
          kind={kind}
          webBase={c.baseUrl}
          organization={c.organization}
        />
        <div aria-live="polite" role="status">
          {pending ? <p className="m-0 text-sm">Testing the new credential…</p> : null}
          {failure ? (
            <>
              <Notice tone="error" role="none">
                <p className="m-0">{failure.message}</p>
              </Notice>
              {failure.report ? (
                <TestReportView report={failure.report} accessLevel={c.accessLevel} />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
          Test and replace
        </Button>
      </div>
    </form>
  );
}
