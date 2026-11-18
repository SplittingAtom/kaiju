"use client";

import { useEffect, useState } from "react";
import type { MemoryItemsApi } from "../../../../lib/memory/items-api";
import type {
  RelatedSiteItem,
  SiteProposal,
  SiteProposalChecks,
} from "../../../../lib/memory/site-proposals-api";
import { visible } from "../../../../lib/security/visible";
import { Button, Field, Select, Textarea } from "../../../ui/console";
import { StatementDiff } from "../../../memory/review/statement-diff";

export interface MergeChoice {
  readonly itemId: string;
  readonly version: number;
  readonly statement: string;
}

const short = (s: string) => {
  const v = visible(s);
  return v.length > 90 ? `${v.slice(0, 89)}…` : v;
};

/**
 * Merge into existing (KOBE-405): pick the Site memory (similar ones first, then the Site's
 * active memories; Policy only for Site admins, the store's rule), see the diff of its saved
 * wording against the new one, and edit the new wording. The merge is that memory's next version.
 */
export function MergePanel({
  proposal,
  checks,
  itemsApi,
  canSetPolicy,
  busy,
  onMerge,
  onCancel,
}: {
  readonly proposal: SiteProposal;
  readonly checks: SiteProposalChecks;
  readonly itemsApi: Pick<MemoryItemsApi, "list">;
  readonly canSetPolicy: boolean;
  readonly busy: boolean;
  readonly onMerge: (choice: MergeChoice) => void;
  readonly onCancel: () => void;
}) {
  const allowed = (r: { readonly policy?: boolean }) => canSetPolicy || !r.policy;
  const similar = [...checks.nearDuplicates, ...(canSetPolicy ? checks.policyConflicts : [])];
  const [others, setOthers] = useState<readonly RelatedSiteItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState("");
  const [statement, setStatement] = useState(proposal.statement);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void itemsApi.list({ scope: "site", status: "active" }).then((res) => {
      if (!current) return;
      if (!res.ok) {
        setLoadError(`Only the similar memories are listed: ${res.error.message}`);
        return;
      }
      setOthers(
        res.data.items.map((i) => ({
          id: i.id,
          version: i.version,
          statement: i.statement,
          policy: i.policy,
        })),
      );
    });
    return () => {
      current = false;
    };
  }, [itemsApi]);

  const similarIds = new Set(similar.map((s) => s.id));
  const rest = others.filter((o) => !similarIds.has(o.id) && allowed(o));
  const target = [...similar, ...rest].find((r) => r.id === targetId) ?? null;

  function submit() {
    if (target === null) {
      setError("Choose the Site memory to merge into.");
      return;
    }
    if (statement.trim() === "") {
      setError("The merged wording can't be empty.");
      return;
    }
    setError(null);
    onMerge({ itemId: target.id, version: target.version, statement: statement.trim() });
  }

  return (
    <div role="group" aria-label="Merge into existing" className="flex flex-col gap-3">
      <Field
        label="Site memory"
        hint="Its next version gets the wording below; earlier versions are kept."
        required
      >
        <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="">Choose a Site memory</option>
          {similar.length > 0 && (
            <optgroup label="Similar">
              {similar.map((r) => (
                <option key={r.id} value={r.id}>
                  {short(r.statement)}
                </option>
              ))}
            </optgroup>
          )}
          {rest.length > 0 && (
            <optgroup label="All Site memories">
              {rest.map((r) => (
                <option key={r.id} value={r.id}>
                  {short(r.statement)}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>
      {loadError && <p className="m-0 text-sm text-console-muted">{loadError}</p>}
      <Field label="Merged wording" hint="The proposal's statement; edit it to combine the two.">
        <Textarea
          value={statement}
          rows={3}
          onChange={(e) => setStatement(e.target.value)}
          className="w-full"
        />
      </Field>
      {target && (
        <div>
          <p className="m-0 text-sm font-semibold">
            Saved wording against the merged wording (struck words go, underlined words come in)
          </p>
          <StatementDiff before={target.statement} after={statement} />
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-status-failed">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={submit}>
          Merge
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
