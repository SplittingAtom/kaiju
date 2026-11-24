"use client";

import { useId, useState } from "react";
import type { GitApproval } from "@kobe/protocol";
import { visible } from "../../lib/security/visible";
import styles from "./chat.module.css";

/**
 * A git host write's card header (KOBE-762, spec workspace-git G9, G10, G13): what will happen, on
 * which host, organization and repository, built by the server from the approved input. Titles
 * and bodies are shown as plain text exactly as they will be posted (Kaiju's last line naming the
 * member and the conversation included), hidden characters as visible escapes, never as HTML or
 * Markdown; a long body is cut with a "Show all" control. The exact input is still shown below.
 */

const ACTION: Record<GitApproval["action"], string> = {
  create_repository: "Create a repository",
  create_branch: "Create a branch",
  open_pull_request: "Open a pull request",
  comment: "Add a comment",
  create_issue: "Create an issue",
};

const PROVIDER: Record<GitApproval["provider"], string> = {
  github: "GitHub",
  gitea: "Gitea",
  forgejo: "Forgejo",
};

/** Characters of a body shown before "Show all". */
export const GIT_BODY_PREVIEW = 1_200;

function Body({ text }: { readonly text: string }) {
  const [all, setAll] = useState(false);
  const id = useId();
  const long = text.length > GIT_BODY_PREVIEW;
  const shown = all || !long ? text : `${text.slice(0, GIT_BODY_PREVIEW)}…`;
  return (
    <>
      <pre id={id} className={styles.toolPre} aria-label="Text that will be posted">
        {visible(shown)}
      </pre>
      {long && (
        <button type="button" aria-expanded={all} aria-controls={id} onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show all (${text.length.toLocaleString()} characters)`}
        </button>
      )}
    </>
  );
}

export function GitChange({ git }: { readonly git: GitApproval }) {
  const rows: [string, string][] = [];
  if (git.action === "create_repository") {
    rows.push(["New repository", git.repository]);
    rows.push(["Visibility", git.visibility === "internal" ? "Internal" : "Private"]);
    if (git.description !== undefined && git.description !== "") {
      rows.push(["Description", git.description]);
    }
  } else {
    rows.push(["Repository", git.repository]);
  }
  if (git.action === "create_branch") {
    rows.push(["New branch", git.branch ?? ""]);
    rows.push(["Starts from", git.from ?? ""]);
  }
  if (git.action === "open_pull_request") {
    rows.push(["From branch", git.head ?? ""]);
    rows.push(["Into branch", git.base ?? ""]);
    if (git.draft === true) rows.push(["Draft", "Yes"]);
  }
  if (git.action === "comment") {
    rows.push([git.on === "pull_request" ? "Pull request" : "Issue", `#${git.number ?? ""}`]);
  }
  if (git.title !== undefined) rows.push(["Title", git.title]);
  return (
    <div data-kobe-git-change="">
      <p className={styles.who}>
        <strong>{ACTION[git.action]}</strong> on {PROVIDER[git.provider]}{" "}
        <strong>{visible(git.host)}</strong>, organization{" "}
        <strong>{visible(git.organization)}</strong> (connection {visible(git.connection_name)})
      </p>
      <table aria-label="What will be created" className={styles.toolPre}>
        <tbody>
          {rows.map(([field, value]) => (
            <tr key={field}>
              <th scope="row">{field}</th>
              <td>{visible(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {git.body !== undefined && <Body text={git.body} />}
      <p className={styles.hint}>
        This sends Workspace content to the git host, where Kaiju cannot take it back.
      </p>
    </div>
  );
}
