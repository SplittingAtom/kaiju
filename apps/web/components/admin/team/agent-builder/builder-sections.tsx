"use client";

import { slugFromName } from "@kaiju/agent-file";
import type { AgentMemorySetting } from "@kaiju/protocol";
import type { RefObject } from "react";
import {
  getAgentVersion,
  setTeamAgentMemory,
  type AgentDetail,
  type PublishedAgent,
} from "../../../../lib/admin/api/team/agent-builder";
import type {
  BuilderTab,
  FieldErrors,
  FormState,
} from "../../../../lib/admin/agent-builder/form-model";
import {
  Button,
  Field,
  Notice,
  Section,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextInput,
} from "../../../ui/console";
import { fieldError } from "./field-errors";
import { BehaviourFields } from "./behaviour-fields";
import { IdentityFields } from "./identity-fields";
import { MemorySetting } from "./memory-setting";
import { OrbitExportButton } from "./orbit-export-button";
import { SkillUpdates } from "./skill-updates";
import { AgentTestPane } from "./test-pane";
import type { BuilderScope } from "./builder-model";

/** The notices above the form: a roster view, an archived or suspended agent, problems, an added skill. */
export function BuilderNotices({
  agent,
  rosterVersion,
  attempted,
  problemCount,
  added,
  dirty,
}: {
  readonly agent: AgentDetail | null;
  readonly rosterVersion: number | undefined;
  readonly attempted: boolean;
  readonly problemCount: number;
  readonly added: string | undefined;
  readonly dirty: boolean;
}) {
  return (
    <>
      {rosterVersion !== undefined && (
        <Notice tone="info">
          <p>
            You&apos;re viewing v{rosterVersion}, the version this roster runs. Only its owner edits
            it; fork it from the Agents page to make your own copy.
          </p>
        </Notice>
      )}
      {agent?.archivedAt && (
        <Notice tone="warn">
          <p>This agent is archived, so it can&apos;t be changed.</p>
        </Notice>
      )}
      {agent?.status === "suspended" && (
        <Notice tone="warn">
          <p>
            This agent is suspended by a team admin, so it can&apos;t start new runs. You can still
            edit and publish it.
          </p>
        </Notice>
      )}
      {attempted && problemCount > 0 && (
        <Notice tone="error">
          <p>
            Fix {problemCount} {problemCount === 1 ? "problem" : "problems"} before saving.
          </p>
        </Notice>
      )}
      {added !== undefined && dirty && (
        <p role="status" className="text-sm text-console-muted">
          Added {added} to this agent&apos;s skills. Save the draft and publish it to use the skill.
        </p>
      )}
    </>
  );
}

/** The editable form: the Identity and Behaviour tabs and the Save / Publish row. */
export function BuilderForm({
  agent,
  form,
  prompt,
  slug,
  errors,
  tab,
  readOnly,
  canPublish,
  dirty,
  pending,
  evaluating,
  publishButton,
  onTabChange,
  onSlugChange,
  onFormChange,
  onPromptChange,
  onSubmit,
  onPublish,
}: {
  readonly agent: AgentDetail | null;
  readonly form: FormState;
  readonly prompt: string;
  readonly slug: string;
  readonly errors: FieldErrors;
  readonly tab: BuilderTab;
  readonly readOnly: boolean;
  readonly canPublish: boolean;
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly evaluating: boolean;
  readonly publishButton: RefObject<HTMLButtonElement | null>;
  readonly onTabChange: (tab: BuilderTab) => void;
  readonly onSlugChange: (slug: string) => void;
  readonly onFormChange: (form: FormState) => void;
  readonly onPromptChange: (prompt: string) => void;
  readonly onSubmit: () => void;
  readonly onPublish: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!readOnly) onSubmit();
      }}
      noValidate
    >
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as BuilderTab)}>
        <TabsList label="Agent settings">
          <TabsTrigger value="identity">Identity</TabsTrigger>
          <TabsTrigger value="behaviour">Behaviour</TabsTrigger>
        </TabsList>
        {/* Both panels stay mounted (state and errors survive a switch); the inactive one is hidden. */}
        <TabsContent value="identity" forceMount className="data-[state=inactive]:hidden">
          {!agent && (
            <Field
              label="Slug"
              hint={`Optional and permanent. Defaults to ${slugFromName(form.name)}.`}
              error={fieldError(errors.slug)}
              className="my-4"
            >
              <TextInput type="text" value={slug} onChange={(e) => onSlugChange(e.target.value)} />
            </Field>
          )}
          <IdentityFields
            form={form}
            prompt={prompt}
            errors={errors}
            readOnly={readOnly}
            onChange={onFormChange}
            onPromptChange={onPromptChange}
          />
        </TabsContent>
        <TabsContent value="behaviour" forceMount className="data-[state=inactive]:hidden">
          <BehaviourFields
            form={form}
            errors={errors}
            readOnly={readOnly}
            onChange={onFormChange}
          />
        </TabsContent>
      </Tabs>
      {errors.form && (
        <p role="alert" className="m-0 mt-2 text-sm font-medium text-console-danger">
          {errors.form.join(" ")}
        </p>
      )}
      {!readOnly && (
        <div className="my-4 flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {agent ? "Save draft" : "Create agent"}
          </Button>
          {canPublish && (
            <Button
              ref={publishButton}
              disabled={dirty || pending || evaluating}
              onClick={onPublish}
            >
              {evaluating ? "Evaluating…" : "Publish…"}
            </Button>
          )}
          {canPublish && dirty && (
            <span className="text-sm text-console-muted">Save your changes to publish them.</span>
          )}
          {agent && !dirty && (
            <span className="text-sm text-console-muted">
              {agent.currentVersion === null
                ? "Never published."
                : `Current version: v${agent.currentVersion}.`}
            </span>
          )}
        </div>
      )}
    </form>
  );
}

/** Under the form: the memory setting, skill updates, the test chat and the Orbit export. */
export function AgentTools({
  teamId,
  agent,
  scope,
  historyKey,
  rosterView,
  readOnly,
  canPublish,
  canExport,
  dirty,
  busy,
  testing,
  onTestingChange,
  onMemoryChanged,
}: {
  readonly teamId: string;
  readonly agent: AgentDetail;
  readonly scope: BuilderScope;
  readonly historyKey: number;
  readonly rosterView: boolean;
  readonly readOnly: boolean;
  readonly canPublish: boolean;
  readonly canExport: boolean;
  readonly dirty: boolean;
  /** Saving or evaluating: the memory setting waits. */
  readonly busy: boolean;
  readonly testing: boolean;
  readonly onTestingChange: (testing: boolean) => void;
  readonly onMemoryChanged: (result: PublishedAgent, memory: AgentMemorySetting) => void;
}) {
  return (
    <>
      {!rosterView && (
        <MemorySetting
          key={`${agent.currentVersion ?? 0}:${historyKey}`}
          agentId={agent.id}
          api={{
            readVersion: (version) => getAgentVersion(teamId, agent.id, version),
            save: (memory) => setTeamAgentMemory(teamId, agent.id, memory),
          }}
          currentVersion={agent.currentVersion}
          canChange={canPublish}
          busy={busy}
          onChanged={onMemoryChanged}
        />
      )}
      {scope === "team" && agent.currentVersion !== null && (
        <SkillUpdates
          key={`${agent.currentVersion}:${historyKey}`}
          teamId={teamId}
          agentId={agent.id}
          version={agent.currentVersion}
        />
      )}
      {!readOnly && (
        <Section
          id="test-chat-heading"
          title="Test chat"
          description={`Chat with the unpublished draft as last saved${dirty ? " (save your edits first)" : ""}. It runs with the same policy, approvals and budgets as a published agent.`}
        >
          {testing ? (
            <>
              <AgentTestPane key={agent.id} teamId={teamId} agentId={agent.id} />
              <Button onClick={() => onTestingChange(false)}>Close test chat</Button>
            </>
          ) : (
            <Button onClick={() => onTestingChange(true)}>Test chat</Button>
          )}
        </Section>
      )}
      {canExport && agent.currentVersion !== null && (
        <div className="my-4 flex flex-wrap items-center gap-2">
          <OrbitExportButton
            teamId={teamId}
            agentId={agent.id}
            agentSlug={agent.slug}
            version={agent.currentVersion}
          />
          <span className="text-sm text-console-muted">
            Downloads v{agent.currentVersion} as Orbit YAML for safety evaluation.
          </span>
        </div>
      )}
    </>
  );
}
