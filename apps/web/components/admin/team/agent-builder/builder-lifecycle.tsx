"use client";

import type { RefObject } from "react";
import type { AgentDetail, AgentEval } from "../../../../lib/admin/api/team/agent-builder";
import type { validateForm } from "../../../../lib/admin/agent-builder/form-model";
import { SharedCasesSummary } from "../eval-cases/shared-cases-summary";
import { AgentQuality } from "./agent-quality";
import { EvalStatus } from "./eval-status";
import { PublishDialog } from "./publish-dialog";
import { leftOutText } from "./skill-updates";
import { VersionHistory, type MemoryChange } from "./version-history";
import type { BuilderScope } from "./builder-model";

type PublishResult = Parameters<NonNullable<Parameters<typeof PublishDialog>[0]["onPublished"]>>[0];

/** Under the tools: the eval status, the Publish dialog, quality, shared cases and version history. */
export function AgentLifecycle({
  teamId,
  agent,
  scope,
  validation,
  historyKey,
  rosterView,
  canPublish,
  canExport,
  dirty,
  pending,
  publishing,
  evalStarted,
  publishButton,
  onPublishingChange,
  onEvalStarted,
  onEvaluatingChange,
  onEvalFinished,
  onPublished,
  onRestore,
}: {
  readonly teamId: string;
  readonly agent: AgentDetail;
  readonly scope: BuilderScope;
  readonly validation: ReturnType<typeof validateForm>;
  readonly historyKey: number;
  readonly rosterView: boolean;
  readonly canPublish: boolean;
  readonly canExport: boolean;
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly publishing: boolean;
  readonly evalStarted: AgentEval | null;
  readonly publishButton: RefObject<HTMLButtonElement | null>;
  readonly onPublishingChange: (publishing: boolean) => void;
  readonly onEvalStarted: (started: AgentEval) => void;
  readonly onEvaluatingChange: (evaluating: boolean) => void;
  readonly onEvalFinished: (finished: AgentEval) => unknown;
  /** A publish landed: the server's agent, the version and the "Published" notice text. */
  readonly onPublished: (result: PublishResult, notice: string) => void;
  readonly onRestore: (
    version: number,
    trigger: HTMLElement | null,
    memory?: MemoryChange,
  ) => unknown;
}) {
  return (
    <>
      {!agent.archivedAt && !rosterView && (
        <EvalStatus
          teamId={teamId}
          agentId={agent.id}
          started={evalStarted}
          canRetry={canPublish && !dirty}
          onActiveChange={onEvaluatingChange}
          onFinished={(finished) => void onEvalFinished(finished)}
          onRetry={() => onPublishingChange(true)}
        />
      )}
      {publishing && validation.ok && (
        <PublishDialog
          teamId={teamId}
          agent={agent}
          warnings={validation.warnings}
          // The Publish button, or, while an evaluation it started runs (the button is disabled),
          // the evaluation's heading.
          returnFocus={() =>
            publishButton.current?.disabled === false
              ? publishButton.current
              : document.getElementById("eval-heading")
          }
          onClose={() => onPublishingChange(false)}
          onEvaluating={(started) => {
            onEvalStarted(started);
            onPublishingChange(false);
          }}
          onPublished={(result, version) => {
            // KOBE-318: named team skills with no loadable version are left out of the version.
            const leftOut = (result.skillsLeftOut ?? []).map((s) => leftOutText(s, version));
            onPublished(result, [`Published v${version}.`, ...leftOut].join(" "));
            onPublishingChange(false);
          }}
        />
      )}
      {!rosterView && <AgentQuality teamId={teamId} agentId={agent.id} />}
      {!rosterView && <SharedCasesSummary teamId={teamId} agentId={agent.id} scope={scope} />}
      <VersionHistory
        key={historyKey}
        teamId={teamId}
        agentId={agent.id}
        currentVersion={agent.currentVersion}
        agentSlug={agent.slug}
        canExport={canExport}
        canRestore={canPublish}
        restoring={pending}
        onRestore={(v, trigger, memory) => void onRestore(v, trigger, memory)}
      />
    </>
  );
}
