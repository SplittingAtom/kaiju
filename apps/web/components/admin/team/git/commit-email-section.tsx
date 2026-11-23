"use client";

import { useId, useState, type FormEvent } from "react";
import {
  getGitSettings,
  setGitCommitEmail,
  type GitCommitEmail,
  type GitWorkspaceSettings,
} from "../../../../lib/admin/api/team/git";
import { Button, ChoiceGroup, Radio, Section } from "../../../ui/console";
import { MutationStatus } from "../../error-notice";
import { ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";

/**
 * Commit author email (spec G13, GQ10; KOBE-764 writes it into sandbox commits): the member's Kobe
 * email (default) or a no-reply address under the Site's host. `/v1/team/git/settings`.
 */
export function CommitEmailSection({ teamId }: { readonly teamId: string }) {
  const { state, reload } = useResource(() => getGitSettings(teamId));
  return (
    <Section
      title="Commit author email"
      description="The email address on commits made in members' sandboxes. Commits pushed to the host keep it in their history for good, even if you change this later."
    >
      <ResourceView state={state} label="git settings">
        {(settings) => <CommitEmailForm teamId={teamId} settings={settings} onSaved={reload} />}
      </ResourceView>
    </Section>
  );
}

function CommitEmailForm({
  teamId,
  settings,
  onSaved,
}: {
  readonly teamId: string;
  readonly settings: GitWorkspaceSettings;
  readonly onSaved: () => void;
}) {
  const ids = useId();
  const mutation = useMutation();
  const [choice, setChoice] = useState<GitCommitEmail>(settings.commitEmail);

  async function save(e: FormEvent) {
    e.preventDefault();
    const done = await mutation.run(
      () => setGitCommitEmail(teamId, choice),
      (saved) =>
        saved.commitEmail === "noreply"
          ? "New commits in sandboxes now use each member's no-reply address."
          : "New commits in sandboxes now use each member's Kobe email.",
    );
    if (done) onSaved();
  }

  return (
    <form aria-label="Commit author email" onSubmit={(e) => void save(e)}>
      <ChoiceGroup legend="Author email on sandbox commits" stacked>
        <Radio
          name={`${ids}-email`}
          label="Member's Kobe email"
          hint="Each commit shows the member's name and the email they sign in to Kobe with; anyone who can read the repository on the host sees it."
          checked={choice === "member"}
          onChange={() => setChoice("member")}
        />
        <Radio
          name={`${ids}-email`}
          label="No-reply address"
          hint={
            <>
              Each commit shows the member&apos;s name and an address that receives no mail and does
              not reveal their email. Yours would be{" "}
              <code className="break-all">{settings.noreplyExample}</code>.
            </>
          }
          checked={choice === "noreply"}
          onChange={() => setChoice("noreply")}
        />
      </ChoiceGroup>
      <div className="mt-3">
        <Button
          type="submit"
          variant="primary"
          disabled={mutation.pending || choice === settings.commitEmail}
        >
          Save commit email
        </Button>
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
