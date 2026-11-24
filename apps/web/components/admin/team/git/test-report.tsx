"use client";

import { CircleCheckIcon, CircleHelpIcon, CircleXIcon } from "lucide-react";
import type {
  GitAccessLevel,
  GitCapabilities,
  GitReport,
} from "../../../../lib/admin/api/team/git";
import {
  ACCESS_LABEL,
  CAPABILITY_LABEL,
  CAPABILITY_ORDER,
  CAPABILITY_VALUE_LABEL,
  PROVIDER_LABEL,
  type GitCapabilityName,
} from "../../../../lib/admin/git/labels";
import { Notice } from "../../../ui/console";
import { DateTime } from "../../parts";

const ICON = { yes: CircleCheckIcon, no: CircleXIcon, unknown: CircleHelpIcon } as const;
const TONE = {
  yes: "text-status-running",
  no: "text-status-failed",
  unknown: "text-console-muted",
} as const;

/** What the credential may do, as words with a matching icon (colour is never the only cue). */
export function CapabilityList({
  capabilities,
  label,
}: {
  readonly capabilities: GitCapabilities;
  readonly label: string;
}) {
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm">
      {CAPABILITY_ORDER.map((name) => {
        const value = capabilities[name];
        const Icon = ICON[value];
        return (
          <li key={name} className="flex items-center gap-1.5">
            <Icon aria-hidden className={`size-4 shrink-0 ${TONE[value]}`} />
            <span>
              {CAPABILITY_LABEL[name]}: <strong>{CAPABILITY_VALUE_LABEL[value]}</strong>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const names = (caps: readonly GitCapabilityName[]) =>
  caps.map((c) => CAPABILITY_LABEL[c].toLowerCase()).join(", ");

/** One test's findings (G4): organization, who actions appear as, capabilities, warnings. */
export function TestReportView({
  report,
  accessLevel,
}: {
  readonly report: GitReport;
  readonly accessLevel: GitAccessLevel;
}) {
  const org = report.organization;
  return (
    <div className="flex flex-col gap-2" data-testid="git-test-report">
      <Notice tone={report.ok ? "success" : "error"} role="none">
        <p className="m-0 font-medium">
          {report.ok
            ? `Test passed: the credential can do what ${ACCESS_LABEL[accessLevel]} needs.`
            : `Test failed: the credential cannot ${names(report.missing)}, which ${ACCESS_LABEL[accessLevel]} needs.`}
        </p>
      </Notice>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-console-muted">{org.kind === "user" ? "User" : "Organization"}</dt>
        <dd className="m-0">
          {org.login}
          {org.name && org.name !== org.login ? ` (${org.name})` : ""}
        </dd>
        <dt className="text-console-muted">Host</dt>
        <dd className="m-0">
          {PROVIDER_LABEL[report.provider]}
          {report.hostVersion ? ` ${report.hostVersion}` : ""}
        </dd>
        <dt className="text-console-muted">Acts as</dt>
        <dd className="m-0">
          {report.actor.kind === "app"
            ? `The App's bot${report.actor.login ? ` (${report.actor.login})` : ""}`
            : `The token's owner${report.actor.login ? `, ${report.actor.login}` : ""}`}
        </dd>
        <dt className="text-console-muted">Expires</dt>
        <dd className="m-0">
          {report.credentialExpiresAt ? (
            <DateTime value={report.credentialExpiresAt} />
          ) : (
            "No expiry reported"
          )}
        </dd>
      </dl>
      <CapabilityList capabilities={report.capabilities} label="What the credential may do" />
      {report.warnings.map((w) => (
        <Notice key={w.code} tone="warn" role="none">
          {w.code === "excess_permissions" ? (
            <p className="m-0">
              The credential can do more than Kaiju needs ({w.permissions.join(", ")}). Kaiju never
              uses these, but a narrower credential is safer.
            </p>
          ) : w.code === "more_than_level" ? (
            <p className="m-0">
              The credential can also {names(w.capabilities)}, more than {ACCESS_LABEL[accessLevel]}{" "}
              needs. Kaiju will not use it at this level.
            </p>
          ) : (
            <p className="m-0">
              The host cannot report this credential&apos;s permissions: {names(w.capabilities)}{" "}
              will be known at first use.
            </p>
          )}
        </Notice>
      ))}
    </div>
  );
}
