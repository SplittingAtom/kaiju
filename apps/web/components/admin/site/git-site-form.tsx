"use client";

import { useState, type FormEvent } from "react";
import { putSiteSettings } from "../../../lib/admin/api/site/settings";
import { GIT_ALLOWED_HOSTS_MAX, checkHostList } from "../../../lib/admin/git/address";
import { Button, Checkbox, ChoiceGroup, Field, Textarea } from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { useMutation } from "../use-resource";

/**
 * The Site ceiling for Workspace git (spec G3; KOBE-757 stores it through `PUT
 * /v1/site/settings`): the switch that allows git connections (on by default) and the hosts
 * Workspaces may connect to (empty: any host). The list is checked here with the server's rules
 * before it is sent; the server checks it again. Both changes apply at once and are audited.
 */
export function GitSiteForm({
  enabled,
  hosts,
  onSaved,
}: {
  readonly enabled: boolean;
  readonly hosts: readonly string[];
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [on, setOn] = useState(enabled);
  const [text, setText] = useState(hosts.join("\n"));
  const [problems, setProblems] = useState<readonly string[]>([]);
  const checked = checkHostList(text);
  const unchanged = on === enabled && checked.hosts.join("\n") === [...hosts].join("\n");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setProblems(checked.problems);
    if (checked.problems.length > 0) return;
    const done = await mutation.run(
      () => putSiteSettings({ gitConnectionsEnabled: on, gitAllowedHosts: checked.hosts }),
      (saved) => {
        const list = saved.gitAllowedHosts ?? checked.hosts;
        const where = list.length === 0 ? "any host" : list.join(", ");
        return saved.gitConnectionsEnabled === false
          ? "Git connections are now off for every Workspace."
          : `Git connections are on; Workspaces may connect to ${where}.`;
      },
    );
    if (done) {
      setText(checked.hosts.join("\n"));
      onSaved();
    }
  }

  return (
    <form id="git-connections" onSubmit={onSubmit} aria-label="Git connections" noValidate>
      <ChoiceGroup legend="Git connections" stacked className="my-4">
        <Checkbox
          label="Allow Workspaces to connect git organizations"
          hint="Off: no Workspace can connect, test or check a git organization, and agents stop using existing connections (git tools and git from sandboxes) until it is on again. Stored credentials and connections are kept."
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
        />
        <Field
          label="Allowed git hosts"
          hint={`One host per line, such as github.com or *.example.com (a wildcard covers subdomains only). Leave empty to allow any host. At most ${GIT_ALLOWED_HOSTS_MAX}. A server on a private network also needs the Site's internal targets entry under Egress.`}
          error={
            problems.length > 0 ? (
              <span className="flex flex-col">
                {problems.map((p) => (
                  <span key={p}>{p}</span>
                ))}
              </span>
            ) : undefined
          }
        >
          <Textarea
            rows={4}
            spellCheck={false}
            autoComplete="off"
            className="w-full max-w-md font-mono"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setProblems([]);
            }}
          />
        </Field>
      </ChoiceGroup>
      <Button type="submit" variant="primary" disabled={mutation.pending || unchanged}>
        Save git connections
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
