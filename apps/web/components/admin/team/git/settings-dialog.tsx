"use client";

import { useId, useState, type FormEvent } from "react";
import type { AgentSummary } from "../../../../lib/admin/api/agents";
import { listTeamAgents } from "../../../../lib/admin/api/team/agents";
import {
  updateGitConnection,
  type GitAccessLevel,
  type GitAdminConnection,
} from "../../../../lib/admin/api/team/git";
import { gitErrorMessage } from "../../../../lib/admin/git/errors";
import {
  ACCESS_HINT,
  ACCESS_LABEL,
  ACCESS_LEVELS,
  PUSH_LIMIT_MIB,
  bytesOf,
  mibOf,
} from "../../../../lib/admin/git/labels";
import {
  Button,
  Checkbox,
  ChoiceGroup,
  Dialog,
  DialogClose,
  Field,
  Notice,
  Radio,
  TextInput,
} from "../../../ui/console";
import { useResource } from "../../use-resource";
import { RepoDefaultsFields, checkRepoDefaults, type RepoDefaults } from "./repo-defaults";

/**
 * A connection's settings (spec §7): access level, repository defaults, push size limit, direct
 * commits and which agents may use it. Host, organization and credential are fixed here
 * (Replace credential changes the credential).
 */
export function SettingsDialog({
  open,
  onOpenChange,
  teamId,
  connection,
  returnFocus,
  onSaved,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly teamId: string;
  readonly connection: GitAdminConnection;
  readonly returnFocus: () => HTMLElement | null;
  readonly onSaved: (saved: GitAdminConnection) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Settings for ${connection.displayName}`}
      returnFocus={returnFocus}
    >
      {open ? (
        <SettingsForm
          teamId={teamId}
          connection={connection}
          onSaved={(saved) => {
            onSaved(saved);
            onOpenChange(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function SettingsForm({
  teamId,
  connection: c,
  onSaved,
}: {
  readonly teamId: string;
  readonly connection: GitAdminConnection;
  readonly onSaved: (saved: GitAdminConnection) => void;
}) {
  const ids = useId();
  const [level, setLevel] = useState<GitAccessLevel>(c.accessLevel);
  const [defaults, setDefaults] = useState<RepoDefaults>({
    displayName: c.displayName,
    visibility: c.repoDefaults.visibility,
    prefix: c.repoDefaults.namePrefix,
    branch: c.repoDefaults.defaultBranch,
  });
  const [pushMib, setPushMib] = useState(String(mibOf(c.pushLimitBytes)));
  const [agents, setAgents] = useState<readonly string[] | null>(c.agentIds);
  const [direct, setDirect] = useState(c.directCommits);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const checked = checkRepoDefaults(defaults, c.provider);
    const next: Record<string, string> = checked.ok ? {} : { ...checked.problems };
    if (defaults.displayName.trim() === "") next["displayName"] = "Enter a display name.";
    const mib = Number(pushMib);
    if (!Number.isInteger(mib) || mib < PUSH_LIMIT_MIB.min || mib > PUSH_LIMIT_MIB.max) {
      next["push"] = `Enter a whole number from ${PUSH_LIMIT_MIB.min} to ${PUSH_LIMIT_MIB.max}.`;
    }
    if (agents !== null && agents.length === 0) next["agents"] = "Choose at least one agent.";
    setProblems(next);
    if (!checked.ok || Object.keys(next).length > 0) return;
    setPending(true);
    setError(null);
    try {
      const res = await updateGitConnection(teamId, c.id, {
        ...checked.value,
        access_level: level,
        push_limit_bytes: bytesOf(mib),
        direct_commits: direct,
        agent_ids: agents,
      });
      if (res.ok) onSaved(res.data);
      else setError(gitErrorMessage(res.error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form noValidate aria-label="Connection settings" onSubmit={(e) => void save(e)}>
      <div className="flex flex-col gap-3">
        <ChoiceGroup legend="Access level" stacked>
          {ACCESS_LEVELS.map((l) => (
            <Radio
              key={l}
              name={`${ids}-level`}
              label={ACCESS_LABEL[l]}
              hint={ACCESS_HINT[l]}
              checked={level === l}
              onChange={() => setLevel(l)}
            />
          ))}
        </ChoiceGroup>
        {level === "read_write" && c.capabilities.write === "no" ? (
          <Notice tone="warn" role="none">
            <p className="m-0">
              The last test found that this credential cannot write. Replace it with one that can,
              or agents&apos; writes will fail.
            </p>
          </Notice>
        ) : null}
        <RepoDefaultsFields
          value={defaults}
          onChange={setDefaults}
          provider={c.provider}
          problems={problems}
          placeholderName=""
        />
        <Field
          label="Push size limit (MiB)"
          error={problems["push"]}
          hint={`Largest push from a sandbox. ${PUSH_LIMIT_MIB.min} to ${PUSH_LIMIT_MIB.max}; the default is ${PUSH_LIMIT_MIB.default} (1 GiB).`}
        >
          <TextInput
            type="number"
            className="w-32"
            min={PUSH_LIMIT_MIB.min}
            max={PUSH_LIMIT_MIB.max}
            step={1}
            value={pushMib}
            onChange={(e) => setPushMib(e.target.value)}
          />
        </Field>
        <Checkbox
          label="Allow commits straight to the default branch"
          hint={`Kaiju's Commit dialog and an agent's commit_project on a Repo push to the default branch instead of opening a pull request, where the host allows it (a protected branch still gets a pull request). Off by default. Pushes from a sandbox follow the host's own branch rules either way.`}
          checked={direct}
          onChange={(e) => setDirect(e.target.checked)}
        />
        <AgentsChoice
          teamId={teamId}
          value={agents}
          onChange={setAgents}
          error={problems["agents"]}
        />
        {error ? (
          <Notice tone="error">
            <p className="m-0">{error}</p>
          </Notice>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

/** Every agent in the Workspace (null), or chosen team agents (GQ8). */
function AgentsChoice({
  teamId,
  value,
  onChange,
  error,
}: {
  readonly teamId: string;
  readonly value: readonly string[] | null;
  readonly onChange: (next: readonly string[] | null) => void;
  readonly error: string | undefined;
}) {
  const ids = useId();
  const { state } = useResource(() => listTeamAgents(teamId));
  const agents: readonly AgentSummary[] =
    state.status === "ready" ? state.data.filter((a) => !a.archivedAt) : [];
  return (
    <ChoiceGroup legend="Agents that may use it" stacked error={error}>
      <Radio
        name={`${ids}-agents`}
        label="Every agent in the Workspace"
        hint="Pushing still needs the Contributor role (and editor or owner on a Repo's project)."
        checked={value === null}
        onChange={() => onChange(null)}
      />
      <Radio
        name={`${ids}-agents`}
        label="Only the agents I choose"
        hint="Sandboxes cannot fetch or push through a connection limited to chosen agents: one sandbox serves all of a member's agents."
        checked={value !== null}
        onChange={() => onChange(value ?? [])}
      />
      {value !== null ? (
        <div className="ms-6 flex flex-col gap-1">
          {state.status === "loading" ? <p className="m-0 text-sm">Loading agents…</p> : null}
          {state.status === "error" ? (
            <p className="m-0 text-sm text-console-danger">{state.error.message}</p>
          ) : null}
          {state.status === "ready" && agents.length === 0 ? (
            <p className="m-0 text-sm text-console-muted">This Workspace has no team agents yet.</p>
          ) : null}
          {agents.map((a) => (
            <Checkbox
              key={a.id}
              label={a.name}
              checked={value.includes(a.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, a.id] : value.filter((id) => id !== a.id))
              }
            />
          ))}
        </div>
      ) : null}
    </ChoiceGroup>
  );
}
