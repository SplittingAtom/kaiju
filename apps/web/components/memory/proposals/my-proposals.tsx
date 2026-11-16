"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createProposalsApi,
  type MyProposal,
  type ProposalsApi,
} from "../../../lib/memory/proposals-api";
import { visible } from "../../../lib/security/visible";
import { InlineLink } from "../../shell/text-links";
import { Badge, Button, Card, Notice, Section } from "../../ui/console";
import { ProposalLabels, STATE_LABELS } from "./proposal-parts";

/**
 * Your Workspace proposals (KOBE-397), on My memory: each proposal's outcome and the curator's
 * reason, **Open To review** for one sent back for changes, and one-click **Propose again** for
 * an expired one. Hidden when there are none. `focusId` (`?proposal=<id>` from the bell) is
 * marked and takes focus.
 */
export function MyProposals({
  teamId,
  focusId,
  api: givenApi,
}: {
  readonly teamId: string;
  readonly focusId?: string | null;
  readonly api?: Pick<ProposalsApi, "mine" | "repropose">;
}) {
  const api = useMemo(() => givenApi ?? createProposalsApi(teamId), [givenApi, teamId]);
  const [list, setList] = useState<readonly MyProposal[]>([]);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let current = true;
    void api.mine().then((res) => {
      if (current && res.ok) setList(res.data.proposals);
    });
    return () => {
      current = false;
    };
  }, [api, generation]);

  const focused = useRef(false);
  useEffect(() => {
    if (!focusId || focused.current) return;
    const el = document.querySelector<HTMLElement>(`[data-my-proposal="${CSS.escape(focusId)}"]`);
    if (el) {
      focused.current = true;
      el.focus();
    }
  }, [focusId, list]);

  if (list.length === 0 && notice === null) return null;

  async function again(p: MyProposal) {
    const res = await api.repropose(p.id);
    setNotice(
      res.ok
        ? { tone: "success", text: "Proposed again. Curators have 30 days to decide." }
        : { tone: "error", text: res.error.message },
    );
    if (res.ok) setGeneration((g) => g + 1);
  }

  return (
    <Section id="memory-my-proposals" title="Your Workspace proposals">
      {notice && (
        <Notice tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
          <p className="m-0">{notice.text}</p>
        </Notice>
      )}
      <ul aria-label="Your proposals" className="m-0 flex list-none flex-col gap-3 p-0">
        {list.map((p) => (
          <li key={p.id}>
            <Card
              aria-label={visible(p.statement)}
              className={p.id === focusId ? "flex flex-col gap-2 ring-2" : "flex flex-col gap-2"}
            >
              <p
                className="m-0 font-semibold [overflow-wrap:anywhere]"
                tabIndex={-1}
                data-my-proposal={p.id}
              >
                {visible(p.statement)}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={p.state === "approved" ? "done" : "neutral"}>
                  {p.backInReview ? "Sent back for changes" : STATE_LABELS[p.state]}
                </Badge>
                <ProposalLabels proposal={p} showProposer={false} />
              </div>
              {p.reason && (
                <p className="m-0 text-sm [overflow-wrap:anywhere]">
                  <span className="font-semibold">Curator's reason: </span>
                  {visible(p.reason)}
                </p>
              )}
              {p.backInReview && p.threadId && (
                <p className="m-0 text-sm">
                  <InlineLink href={`/me/memory?review=1&thread=${encodeURIComponent(p.threadId)}`}>
                    Open To review
                  </InlineLink>{" "}
                  to edit it and propose it again.
                </p>
              )}
              {p.mayRepropose && (
                <div>
                  <Button size="sm" onClick={() => void again(p)}>
                    Propose again
                  </Button>
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
}
