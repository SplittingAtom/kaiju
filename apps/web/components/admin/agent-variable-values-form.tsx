"use client";

import { useState, type FormEvent } from "react";
import {
  getSiteAgentVariableValues,
  getTeamAgentVariableValues,
  putSiteAgentVariableValues,
  putTeamAgentVariableValues,
} from "../../lib/admin/api/remember";
import { MutationStatus } from "./error-notice";
import { ResourceView } from "./parts";
import { useMutation, useResource } from "./use-resource";
import { Button, Checkbox, Field, Select } from "../ui/console";

/**
 * KOBE-848: whether the agent's `editor_read` sees the values of strings, bytes and containers in
 * the kernel's variables (numbers, booleans and None always show). Off by default; the Site sets
 * the default and a team turns it on or off or follows the Site.
 */
export const AGENT_VALUES_HINT =
  "When off, the agent reading the Variables tab of an open Python file gets names, types and sizes, and only the values of numbers, booleans and None. When on, it also gets an 80-character preview of strings, bytes and containers; values of credential-like names stay hidden. Those previews end up in the conversation, which people it is shared with can read.";

export function SiteAgentVariableValuesForm() {
  const { state, reload } = useResource(getSiteAgentVariableValues);
  return (
    <ResourceView state={state} label="agent variable values">
      {(current) => <SiteForm enabled={current.enabled} onSaved={reload} />}
    </ResourceView>
  );
}

function SiteForm({
  enabled,
  onSaved,
}: {
  readonly enabled: boolean;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [on, setOn] = useState(enabled);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putSiteAgentVariableValues(on),
      (saved) =>
        saved.enabled
          ? "Teams that follow the Site now show the agent variable values."
          : "Teams that follow the Site now withhold variable values from the agent.",
    );
    if (done) onSaved();
  }
  return (
    <form onSubmit={onSubmit} aria-label="Agent variable values">
      <Checkbox
        label="Show the agent variable values by default"
        hint={AGENT_VALUES_HINT}
        checked={on}
        onChange={(e) => setOn(e.target.checked)}
      />
      <div className="my-4">
        <Button type="submit" variant="primary" disabled={mutation.pending || on === enabled}>
          Save setting
        </Button>
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}

type Choice = "site" | "on" | "off";

export function TeamAgentVariableValuesForm({ teamId }: { readonly teamId: string }) {
  const { state, reload } = useResource(() => getTeamAgentVariableValues(teamId));
  return (
    <ResourceView state={state} label="agent variable values">
      {(current) => (
        <TeamForm
          teamId={teamId}
          initial={current.team === null ? "site" : current.team ? "on" : "off"}
          site={current.site}
          onSaved={reload}
        />
      )}
    </ResourceView>
  );
}

function TeamForm({
  teamId,
  initial,
  site,
  onSaved,
}: {
  readonly teamId: string;
  readonly initial: Choice;
  readonly site: boolean;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [choice, setChoice] = useState<Choice>(initial);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const enabled = choice === "site" ? null : choice === "on";
    const done = await mutation.run(
      () => putTeamAgentVariableValues(teamId, enabled),
      (saved) =>
        saved.effective
          ? "The agent now sees variable values in this team."
          : "Variable values are now withheld from the agent in this team.",
    );
    if (done) onSaved();
  }
  return (
    <form onSubmit={onSubmit} aria-label="Agent variable values">
      <Field label="Variable values for the agent" hint={AGENT_VALUES_HINT}>
        <Select value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
          <option value="site">Use the Site default ({site ? "shown" : "withheld"})</option>
          <option value="on">Show values</option>
          <option value="off">Withhold values</option>
        </Select>
      </Field>
      <div className="my-4">
        <Button type="submit" variant="primary" disabled={mutation.pending || choice === initial}>
          Save setting
        </Button>
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
