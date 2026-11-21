"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import {
  createTeamAgent,
  getTeamAgent,
  rollbackTeamAgent,
  saveTeamAgent,
  type AgentDetail,
  type AgentEval,
} from "../../../../lib/admin/api/team/agent-builder";
import { firstTabWithError, type BuilderTab } from "../../../../lib/admin/agent-builder/form-model";
import { PageHeader, useConfirm, useUnsavedChanges } from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { MutationStatus } from "../../error-notice";
import { ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";
import { AgentLifecycle } from "./builder-lifecycle";
import {
  baselineOf,
  HOME,
  restoreNotes,
  useBuilderErrors,
  withSkill,
  type BuilderScope,
} from "./builder-model";
import { AgentTools, BuilderForm, BuilderNotices } from "./builder-sections";
import { DangerousBadge } from "./dangerous-badge";
import { MEMORY_SETTING_LABELS } from "./memory-setting";
import type { MemoryChange } from "./version-history";
import { useNavigate } from "../../../shell/use-navigate";

export type { BuilderScope };

/**
 * Create, edit and publish an agent from one page (spec D19; `/v1/agents`, KOBE-84). The same
 * builder serves personal agents in the member's own area (KOBE-97); the server decides who may
 * edit and publish and reports it as `canEdit` / `canPublish`.
 */
export function AgentBuilderPage({
  agentId,
  scope = "team",
  addSkill,
  rosterFrom,
}: {
  readonly agentId?: string;
  readonly scope?: BuilderScope;
  /** A skill page's "Add to agent…" (KOBE-297): the draft opens with this skill added. */
  readonly addSkill?: string | undefined;
  /** The roster a View was opened from (`?from=site`, KOBE-571): which version in effect shows. */
  readonly rosterFrom?: "team" | "site" | undefined;
}) {
  const teamId = useTeamAccess().team.id;
  return agentId ? (
    <ExistingAgent
      teamId={teamId}
      agentId={agentId}
      scope={scope}
      addSkill={addSkill}
      rosterFrom={rosterFrom}
    />
  ) : (
    <Builder teamId={teamId} initial={null} scope={scope} />
  );
}

function ExistingAgent({
  teamId,
  agentId,
  scope,
  addSkill,
  rosterFrom,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly scope: BuilderScope;
  readonly addSkill?: string | undefined;
  readonly rosterFrom?: "team" | "site" | undefined;
}) {
  const { state } = useResource(() => getTeamAgent(teamId, agentId, rosterFrom));
  if (state.status !== "ready") {
    // Loading or refused: the way back stays on the page.
    return (
      <>
        <BackLink scope={scope} />
        <ResourceView state={state} label="agent">
          {() => null}
        </ResourceView>
      </>
    );
  }
  return <Builder teamId={teamId} initial={state.data.agent} scope={scope} addSkill={addSkill} />;
}

function BackLink({ scope }: { readonly scope: BuilderScope }) {
  const home = HOME[scope];
  return (
    <p className="m-0 mb-1 text-sm">
      <Link href={home.list}>{home.back}</Link>
    </p>
  );
}

function Builder({
  teamId,
  initial,
  scope,
  addSkill,
}: {
  readonly teamId: string;
  readonly initial: AgentDetail | null;
  readonly scope: BuilderScope;
  readonly addSkill?: string | undefined;
}) {
  const home = HOME[scope];
  const [agent, setAgent] = useState(initial);
  const [baseline, setBaseline] = useState(() => baselineOf(initial));
  const [form, setForm] = useState(() =>
    initial?.canEdit && !initial.archivedAt ? withSkill(baseline.form, addSkill) : baseline.form,
  );
  const added = form.skills !== baseline.form.skills ? addSkill : undefined;
  const [prompt, setPrompt] = useState(baseline.prompt);
  const [slug, setSlug] = useState("");
  // A skill page's "Add to agent…" opens where the skill was added (the Behaviour tab).
  const [tab, setTab] = useState<BuilderTab>(added === undefined ? "identity" : "behaviour");
  const [attempted, setAttempted] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [testing, setTesting] = useState(false);
  // KOBE-93: the Orbit eval a Publish started (the draft is "evaluating" until it ends).
  const [evalStarted, setEvalStarted] = useState<AgentEval | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const mutation = useMutation();
  // A new agent opens at its own address, inside the panel (KOBE-452): no page load.
  const navigate = useNavigate();
  const [confirm, confirmDialog] = useConfirm();
  const publishButton = useRef<HTMLButtonElement>(null);

  const readOnly = agent !== null && (!agent.canEdit || Boolean(agent.archivedAt));
  const { validation, slugErrors, errors, problemCount } = useBuilderErrors(
    form,
    prompt,
    agent,
    slug,
    attempted,
  );
  const dirty = JSON.stringify({ form, prompt }) !== JSON.stringify(baseline);
  // In its panel (KOBE-452), closing asks while the form has edits not saved.
  useUnsavedChanges(dirty);

  function apply(next: AgentDetail) {
    const fresh = baselineOf(next);
    setAgent(next);
    setBaseline(fresh);
    setForm(fresh.form);
    setPrompt(fresh.prompt);
    setAttempted(false);
  }

  async function save() {
    setAttempted(true);
    setPublished(null);
    if (!validation.ok || slugErrors.length > 0) {
      // KOBE-476: the form opens the tab that holds the (first) field to fix.
      const fix = firstTabWithError({
        ...(validation.ok ? {} : validation.errors),
        ...(slugErrors.length ? { slug: slugErrors } : {}),
      });
      if (fix) setTab(fix);
      return;
    }
    const body = {
      frontmatter: validation.definition.frontmatter as Record<string, unknown>,
      prompt: validation.definition.prompt,
    };
    const done = await mutation.run(
      async () => {
        const res = agent
          ? await saveTeamAgent(teamId, agent, body)
          : await createTeamAgent(teamId, { ...body, slug: slug || undefined }, scope);
        if (res.ok && agent) apply(res.data.agent);
        if (res.ok && !agent) navigate(`${home.base}/${res.data.agent.id}`);
        // Only an admin may use Dangerous mode (AC1): the refusal is about the Behaviour tab.
        if (!res.ok && res.error.code === "dangerous_mode_forbidden") setTab("behaviour");
        return res;
      },
      () => (agent ? "Draft saved." : "Agent created."),
    );
    return done;
  }

  async function restore(version: number, trigger: HTMLElement | null, memory?: MemoryChange) {
    if (!agent) return;
    // KOBE-646 (review L2): a restore brings back that version's memory setting; say so.
    const notes = restoreNotes(memory, dirty);
    const yes = await confirm(
      {
        title: `Restore version ${version} as the newest version?`,
        ...(notes.length > 0 ? { description: notes.join(" ") } : {}),
        confirmLabel: `Restore version ${version}`,
        tone: "primary",
      },
      trigger,
    );
    if (!yes) return;
    setPublished(null);
    await mutation.run(
      async () => {
        const res = await rollbackTeamAgent(teamId, agent.id, version);
        if (res.ok) {
          apply(res.data.agent);
          setHistoryKey((k) => k + 1);
        }
        return res;
      },
      (data) => `Restored v${version} as v${data.version.version}.`,
    );
  }

  /** An eval ended: a pass published a version, so take the server's agent and history. */
  async function evalFinished(finished: AgentEval) {
    if (finished.status !== "passed" || !agent) return;
    const res = await getTeamAgent(teamId, agent.id);
    if (res.ok) {
      apply(res.data.agent);
      setHistoryKey((k) => k + 1);
      if (finished.version !== null) setPublished(`Published v${finished.version}.`);
    }
  }

  // Publishing is its own right (the server checks `access.publish`), separate from editing.
  const canPublish = agent !== null && !readOnly && agent.canPublish === true;
  // Someone else's agent viewed from a roster (KOBE-571, AR14): its version in effect, read-only;
  // the owner's evals, ratings, cases and exports stay theirs.
  const rosterVersion = agent?.versionInEffect;
  const rosterView = rosterVersion !== undefined;
  // Exporting needs the right to read the definition, not edit rights (archived agents export too).
  const canExport = agent !== null && agent.canExport === true && !rosterView;

  const shared = { teamId, scope, historyKey, rosterView, canPublish, canExport };

  return (
    <>
      <PageHeader
        title={agent ? agent.name : home.title}
        back={<Link href={home.list}>{home.back}</Link>}
        {...(agent?.dangerous ? { actions: <DangerousBadge /> } : {})}
      />
      <BuilderNotices
        agent={agent}
        rosterVersion={rosterVersion}
        attempted={attempted}
        problemCount={problemCount}
        added={added}
        dirty={dirty}
      />
      <MutationStatus error={mutation.error} notice={published ?? mutation.notice} />
      <BuilderForm
        agent={agent}
        form={form}
        prompt={prompt}
        slug={slug}
        errors={errors}
        tab={tab}
        readOnly={readOnly}
        canPublish={canPublish}
        dirty={dirty}
        pending={mutation.pending}
        evaluating={evaluating}
        publishButton={publishButton}
        onTabChange={setTab}
        onSlugChange={setSlug}
        onFormChange={setForm}
        onPromptChange={setPrompt}
        onSubmit={() => void save()}
        onPublish={() => setPublishing(true)}
      />
      {agent && (
        <AgentTools
          {...shared}
          agent={agent}
          readOnly={readOnly}
          dirty={dirty}
          busy={mutation.pending || evaluating}
          testing={testing}
          onTestingChange={setTesting}
          onMemoryChanged={(result, memory) => {
            apply(result.agent);
            setHistoryKey((k) => k + 1);
            setPublished(
              `Memory set to ${MEMORY_SETTING_LABELS[memory].label.toLowerCase()} in v${result.version.version}.`,
            );
          }}
        />
      )}
      {agent && (
        <AgentLifecycle
          {...shared}
          agent={agent}
          validation={validation}
          dirty={dirty}
          pending={mutation.pending}
          publishing={publishing}
          evalStarted={evalStarted}
          publishButton={publishButton}
          onPublishingChange={setPublishing}
          onEvalStarted={setEvalStarted}
          onEvaluatingChange={setEvaluating}
          onEvalFinished={evalFinished}
          onPublished={(result, notice) => {
            apply(result.agent);
            setHistoryKey((k) => k + 1);
            setPublished(notice);
          }}
          onRestore={restore}
        />
      )}
      {confirmDialog}
    </>
  );
}
