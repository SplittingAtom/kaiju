"use client";

import { useEffect, useRef, useState } from "react";
import type { MemoryItem } from "../../../lib/memory/items-api";
import {
  SITE_JUSTIFICATION_MAX,
  describeSiteChecks,
  type SiteProposalsApi,
} from "../../../lib/memory/site-proposals-api";
import { Button, Field, Textarea } from "../../ui/console";
import { shortName } from "../item-row";

/**
 * Propose to Site on a Workspace memory (KOBE-404, SM19), for its curators: the statement and a
 * required justification go to the Site's curators once a Team admin confirms (a Team admin's own
 * proposal skips that step). The Workspace memory stays as it is. The server checks again
 * (curators only, the Members may propose to the Site switch, the memory checks).
 */
export function ProposeItemToSite({
  item,
  api,
}: {
  readonly item: MemoryItem;
  readonly api: Pick<SiteProposalsApi, "proposeItem">;
}) {
  const [open, setOpen] = useState(false);
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const name = shortName(item.statement);
  const button = useRef<HTMLButtonElement | null>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus || open) return;
    button.current?.focus();
    setRefocus(false);
  }, [refocus, open]);
  const close = () => {
    setOpen(false);
    setRefocus(true);
  };

  async function send() {
    if (justification.trim() === "") return setError("Say why every workspace should know this.");
    setBusy(true);
    setError(null);
    const res = await api.proposeItem(item.id, { justification: justification.trim() });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    const checks = describeSiteChecks(res.data.checks);
    const where =
      res.data.proposal.state === "awaiting_site"
        ? "Proposed to the Site: it waits for the Site's curators."
        : "Proposed to the Site: a Team admin confirms it first (To the Site tab).";
    setDone(checks ? `${where} ${checks}` : where);
    close();
    setJustification("");
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div role="status">{done && <p className="m-0 text-sm">{done}</p>}</div>
      {open ? (
        <div
          role="group"
          aria-label={`Propose to Site: ${name}`}
          className="flex flex-col gap-2 rounded border border-console-border p-3"
        >
          <p className="m-0 text-sm">
            Only the statement, its kind and your reason go to the Site. This memory stays here as
            it is.
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
              autoFocus
              onChange={(e) => setJustification(e.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="m-0 text-sm text-status-failed">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void send()}>
              Propose to the Site
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            ref={button}
            size="sm"
            aria-label={`Propose to Site: ${name}`}
            onClick={() => {
              setDone(null);
              setError(null);
              setOpen(true);
            }}
          >
            Propose to Site
          </Button>
        </div>
      )}
    </div>
  );
}
