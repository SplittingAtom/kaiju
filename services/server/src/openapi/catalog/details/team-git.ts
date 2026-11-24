import {
  gitConnectionCheckedSchema,
  gitConnectionListSchema,
  gitConnectionOneSchema,
  gitConnectionRemovedSchema,
  gitConnectionSavedSchema,
  gitConnectionTestAnswerSchema,
  gitTeamSettingsSchema,
} from "@kaiju/protocol";
import {
  gitConnectionCreateBodySchema,
  gitConnectionCredentialBodySchema,
  gitConnectionTestBodySchema,
  gitConnectionUpdateBodySchema,
} from "../../../git/connection-schemas.js";
import { gitTeamSettingsBodySchema } from "../../../git/team-git-settings.js";
import { named, type CatalogDetail } from "../build.js";

/**
 * Request and response schemas of the Workspace git connection routes (KOBE-760, spec
 * workspace-git §3, §4, §7). Bodies are the routes' own zod schemas; answers are the
 * `@kaiju/protocol` shapes the Git section reads. The credential is write-only: it appears in the
 * create, test and replace bodies and in no answer.
 */

const Saved = named("GitConnectionSaved", gitConnectionSavedSchema);
const One = named("GitConnection", gitConnectionOneSchema);
const CredentialBody = named("GitConnectionCredentialBody", gitConnectionCredentialBodySchema);

const testFailure =
  "A failed test answers 403 `git_disabled` / `host_not_allowed` (the Site's ceiling), 422 " +
  "(`credential_rejected`, `credential_forbidden`, `organization_not_found`, `unsupported_host`, " +
  "`host_refused`, `invalid_base_url`, `credential_insufficient` with the test), 502 " +
  "`host_unreachable` / `host_error` or 503 `host_rate_limited`; never the host's answer.";

const Settings = named("GitTeamSettings", gitTeamSettingsSchema);
const settingsDescription =
  "`commit_email`: `member` (the member's Kaiju email as author of sandbox commits, the default) or " +
  "`noreply` (`<short id>+<name>@users.noreply.<Site host>`); `noreply_example` is the caller's own " +
  "no-reply address.";

export const teamGitDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/team/git/settings": {
    response: Settings,
    responseDescription: settingsDescription,
  },
  "patch /v1/team/git/settings": {
    body: named("GitTeamSettingsBody", gitTeamSettingsBodySchema),
    response: Settings,
    responseDescription: `${settingsDescription} A change is audited as \`git.settings.updated\`.`,
  },
  "get /v1/team/git/connections": {
    response: named("GitConnectionList", gitConnectionListSchema),
    responseDescription:
      "Workspace admins get each connection's admin view and the Site's host list; other members the member view.",
  },
  "post /v1/team/git/connections": {
    body: named("CreateGitConnectionBody", gitConnectionCreateBodySchema),
    status: 201,
    response: Saved,
    responseDescription: `Tested, then stored with the test's report. ${testFailure}`,
    errors: ["409", "413", "422", "429", "502", "503"],
  },
  "post /v1/team/git/connections/test": {
    body: named("TestGitConnectionBody", gitConnectionTestBodySchema),
    response: named("GitConnectionTestAnswer", gitConnectionTestAnswerSchema),
    responseDescription: `What the credential may do; \`test.ok\` false names what is missing. Nothing is stored. ${testFailure}`,
    errors: ["413", "422", "429", "502", "503"],
  },
  "get /v1/team/git/connections/{id}": { response: One, errors: ["404"] },
  "patch /v1/team/git/connections/{id}": {
    body: named("UpdateGitConnectionBody", gitConnectionUpdateBodySchema),
    response: One,
    errors: ["404", "413", "422"],
    responseDescription:
      "The admin view after the change; 422 `unknown_agent` or `internal_not_offered` (Gitea, Forgejo).",
  },
  "delete /v1/team/git/connections/{id}": {
    response: named("GitConnectionRemoved", gitConnectionRemovedSchema),
    responseDescription:
      "Disconnected; the credential is deleted, nothing on the host changes, the Workspace's repository records stay.",
    errors: ["404"],
  },
  "put /v1/team/git/connections/{id}/credential": {
    body: CredentialBody,
    response: Saved,
    responseDescription: `The new credential passed its test and replaced the old one. ${testFailure}`,
    errors: ["404", "413", "422", "429", "502", "503"],
  },
  "post /v1/team/git/connections/{id}/check": {
    body: null,
    response: named("GitConnectionChecked", gitConnectionCheckedSchema),
    responseDescription:
      "Checked now: the stored health with the test, or the error (still 200). 403 when the Site refuses the host.",
    errors: ["404", "429", "503"],
  },
};
