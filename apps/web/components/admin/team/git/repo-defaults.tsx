"use client";

import type {
  GitProvider,
  GitSettingsInput,
  GitVisibility,
} from "../../../../lib/admin/api/team/git";
import { VISIBILITY_LABEL } from "../../../../lib/admin/git/labels";
import { Field, Select, TextInput } from "../../../ui/console";

/** The server's patterns (`GIT_REPO_NAME_PREFIX_PATTERN`, `GIT_BRANCH_NAME_PATTERN`) and limits. */
const PREFIX = /^[A-Za-z0-9._-]{0,40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const BAD_BRANCH = /(\.\.|\/\/|\/$|\.lock$|\.$)/;
const NAME_MAX = 100;

export interface RepoDefaults {
  readonly displayName: string;
  readonly visibility: GitVisibility;
  readonly prefix: string;
  readonly branch: string;
}

export type Checked =
  | { readonly ok: true; readonly value: GitSettingsInput }
  | { readonly ok: false; readonly problems: Record<string, string> };

/** The display name and repository defaults (G1) as route settings, or what is wrong. */
export function checkRepoDefaults(d: RepoDefaults, provider: GitProvider): Checked {
  const problems: Record<string, string> = {};
  const name = d.displayName.trim();
  if (name.length > NAME_MAX || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) {
    problems["displayName"] = `Use at most ${NAME_MAX} characters on one line.`;
  }
  if (!PREFIX.test(d.prefix)) {
    problems["prefix"] = "Letters, digits, dots, hyphens and underscores only (at most 40).";
  }
  if (!BRANCH.test(d.branch) || BAD_BRANCH.test(d.branch)) {
    problems["branch"] = "Enter a valid branch name, such as main.";
  }
  if (d.visibility === "internal" && provider !== "github") {
    problems["visibility"] = "Gitea and Forgejo have no internal repositories: choose Private.";
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      ...(name === "" ? {} : { display_name: name }),
      repo_visibility: d.visibility,
      repo_name_prefix: d.prefix,
      default_branch: d.branch,
    },
  };
}

/** Display name and the defaults for repositories agents create (G1, G10). */
export function RepoDefaultsFields({
  value,
  onChange,
  provider,
  problems,
  placeholderName,
}: {
  readonly value: RepoDefaults;
  readonly onChange: (next: RepoDefaults) => void;
  readonly provider: GitProvider;
  readonly problems: Readonly<Record<string, string>>;
  /** Shown when the name is left empty (the server's default). */
  readonly placeholderName: string;
}) {
  const set = (change: Partial<RepoDefaults>) => onChange({ ...value, ...change });
  return (
    <>
      <Field
        label="Display name"
        error={problems["displayName"]}
        hint="Shown to members and agents. Leave empty for the default."
      >
        <TextInput
          autoComplete="off"
          value={value.displayName}
          placeholder={placeholderName}
          onChange={(e) => set({ displayName: e.target.value })}
        />
      </Field>
      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-1 p-0 font-medium">New repositories</legend>
        <Field
          label="Visibility"
          error={problems["visibility"]}
          hint="Agents never create public repositories."
        >
          <Select
            value={value.visibility}
            onChange={(e) => set({ visibility: e.target.value as GitVisibility })}
          >
            <option value="private">{VISIBILITY_LABEL.private}</option>
            {provider === "github" ? (
              <option value="internal">{VISIBILITY_LABEL.internal}</option>
            ) : null}
          </Select>
        </Field>
        <div className="flex flex-wrap gap-3">
          <Field label="Name prefix" error={problems["prefix"]} hint="Optional, e.g. kobe-.">
            <TextInput
              autoComplete="off"
              spellCheck={false}
              className="w-40"
              value={value.prefix}
              onChange={(e) => set({ prefix: e.target.value })}
            />
          </Field>
          <Field label="Default branch" error={problems["branch"]}>
            <TextInput
              autoComplete="off"
              spellCheck={false}
              className="w-40"
              value={value.branch}
              onChange={(e) => set({ branch: e.target.value })}
            />
          </Field>
        </div>
      </fieldset>
    </>
  );
}
