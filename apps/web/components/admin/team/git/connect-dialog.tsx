"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  createGitConnection,
  testGitConnection,
  type GitAccessLevel,
  type GitCredentialKind,
  type GitReport,
  type GitSaved,
  type GitTarget,
} from "../../../../lib/admin/api/team/git";
import { checkBaseUrl, hostAllowed } from "../../../../lib/admin/git/address";
import { gitErrorMessage, insufficientReport } from "../../../../lib/admin/git/errors";
import {
  ACCESS_HINT,
  ACCESS_LABEL,
  ACCESS_LEVELS,
  GITHUB_COM,
  GIT_HOST_CHOICES,
  HOST_CHOICE_HINT,
  HOST_CHOICE_LABEL,
  providerOfChoice,
  type GitHostChoice,
} from "../../../../lib/admin/git/labels";
import {
  Button,
  ChoiceGroup,
  Dialog,
  DialogClose,
  Field,
  Notice,
  Radio,
  TextInput,
} from "../../../ui/console";
import { CredentialFields, type CredentialHandle } from "./credential-fields";
import { PermissionsHelp } from "./permissions-help";
import { RepoDefaultsFields, checkRepoDefaults, type RepoDefaults } from "./repo-defaults";
import { TestReportView } from "./test-report";

const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const STEPS = ["Host", "Organization and credential", "Test and connect"] as const;

type Outcome =
  | { readonly kind: "report"; readonly report: GitReport }
  | { readonly kind: "error"; readonly message: string; readonly report?: GitReport };

/**
 * Connect a git organization (spec §7): a three-step dialog. 1. provider and address; 2. the
 * organization and the credential, with the exact permissions to choose and a link to the host's
 * form; 3. test without saving, then connect (the server tests again before it stores).
 *
 * The secret fields stay mounted (hidden) across steps, so the credential lives in those DOM
 * fields only; it is read when Test or Connect is pressed, sent, and wiped after connecting and
 * whenever the dialog closes (the dialog's content unmounts).
 */
export function ConnectDialog({
  open,
  onOpenChange,
  teamId,
  allowedHosts,
  returnFocus,
  onConnected,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly teamId: string;
  readonly allowedHosts: readonly string[] | undefined;
  readonly returnFocus: () => HTMLElement | null;
  readonly onConnected: (saved: GitSaved) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect a git organization"
      returnFocus={returnFocus}
    >
      {open ? (
        <ConnectSteps
          teamId={teamId}
          allowedHosts={allowedHosts}
          onConnected={(saved) => {
            onConnected(saved);
            onOpenChange(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function ConnectSteps({
  teamId,
  allowedHosts,
  onConnected,
}: {
  readonly teamId: string;
  readonly allowedHosts: readonly string[] | undefined;
  readonly onConnected: (saved: GitSaved) => void;
}) {
  const ids = useId();
  const credential = useRef<CredentialHandle>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const [choice, setChoice] = useState<GitHostChoice>("github");
  const [address, setAddress] = useState("");
  const [organization, setOrganization] = useState("");
  const [kind, setKind] = useState<GitCredentialKind>("github_app");
  const [level, setLevel] = useState<GitAccessLevel>("read");
  const [defaults, setDefaults] = useState<RepoDefaults>({
    displayName: "",
    visibility: "private",
    prefix: "",
    branch: "main",
  });
  const [problem, setProblem] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);
  const provider = providerOfChoice(choice);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const target = (): Omit<GitTarget, "credential" | "access_level"> | null => {
    if (choice === "github") return { provider, organization: organization.trim() };
    const checked = checkBaseUrl(address);
    if (!checked.ok) return null;
    return { provider, base_url: checked.value.baseUrl, organization: organization.trim() };
  };

  const webBase = (): string | null => {
    if (choice === "github") return GITHUB_COM;
    const checked = checkBaseUrl(address);
    return checked.ok ? checked.value.baseUrl : null;
  };

  /** A test made before an edit no longer counts. */
  const edited = () => setOutcome(null);

  function checkHost(): boolean {
    const host = choice === "github" ? "github.com" : null;
    if (host === null) {
      const checked = checkBaseUrl(address);
      if (!checked.ok) {
        setProblem({ address: checked.reason });
        return false;
      }
      if (!hostAllowed(allowedHosts, checked.value.host)) {
        setProblem({ address: notAllowed(checked.value.host) });
        return false;
      }
    } else if (!hostAllowed(allowedHosts, host)) {
      setProblem({ choice: notAllowed(host) });
      return false;
    }
    setProblem({});
    return true;
  }

  function checkOrganization(): boolean {
    const org = organization.trim();
    const next: Record<string, string> = {};
    if (!ORGANIZATION.test(org)) {
      next["organization"] =
        org === ""
          ? "Enter the organization's name as it appears in its address."
          : "Use the name from the organization's address: letters, digits, dots, hyphens and underscores.";
    }
    setProblem(next);
    // Validates the credential fields too (each says what is missing); the value is dropped.
    const ok = credential.current?.read() !== null;
    return ok && Object.keys(next).length === 0;
  }

  function next() {
    if (step === 0 && checkHost()) setStep(1);
    else if (step === 1 && checkOrganization()) setStep(2);
  }

  async function runTest() {
    const t = target();
    const cred = credential.current?.read() ?? null;
    if (!t || !cred) {
      setOutcome({ kind: "error", message: "Go back and complete the earlier steps." });
      return;
    }
    setPending(true);
    try {
      const res = await testGitConnection(teamId, { ...t, credential: cred, access_level: level });
      setOutcome(
        res.ok
          ? { kind: "report", report: res.data.test }
          : {
              kind: "error",
              message: gitErrorMessage(res.error, undefined, {
                organization: t.organization,
                providerLabel: HOST_CHOICE_LABEL[choice],
              }),
            },
      );
    } finally {
      setPending(false);
    }
  }

  async function connect() {
    const t = target();
    const settings = checkRepoDefaults(defaults, provider);
    if (!settings.ok) {
      setProblem(settings.problems);
      return;
    }
    const cred = credential.current?.read() ?? null;
    if (!t || !cred) return;
    setProblem({});
    setPending(true);
    try {
      const res = await createGitConnection(
        teamId,
        { ...t, credential: cred, access_level: level },
        settings.value,
      );
      if (res.ok) {
        credential.current?.clear();
        onConnected(res.data);
        return;
      }
      const report = insufficientReport(res.error);
      setOutcome({
        kind: "error",
        message: gitErrorMessage(res.error, undefined, {
          organization: t.organization,
          providerLabel: HOST_CHOICE_LABEL[choice],
        }),
        ...(report ? { report } : {}),
      });
    } finally {
      setPending(false);
    }
  }

  const passed = outcome?.kind === "report" && outcome.report.ok;
  return (
    <form
      noValidate
      aria-label="Connect a git organization"
      onSubmit={(e) => {
        e.preventDefault();
        if (step < 2) next();
      }}
    >
      <ol aria-label="Steps" className="m-0 mb-3 flex list-none flex-wrap gap-3 p-0 text-sm">
        {STEPS.map((name, i) => (
          <li
            key={name}
            aria-current={i === step ? "step" : undefined}
            className={i === step ? "font-semibold" : "text-console-muted"}
          >
            {i + 1}. {name}
          </li>
        ))}
      </ol>
      <h3
        ref={heading}
        tabIndex={-1}
        className="m-0 mb-3 text-base font-semibold focus:outline-none"
      >
        Step {step + 1} of 3: {STEPS[step]}
      </h3>

      <div hidden={step !== 0} className="flex flex-col gap-3">
        <ChoiceGroup legend="Provider" stacked error={problem["choice"]}>
          {GIT_HOST_CHOICES.map((c) => (
            <Radio
              key={c}
              name={`${ids}-provider`}
              label={HOST_CHOICE_LABEL[c]}
              hint={HOST_CHOICE_HINT[c]}
              checked={choice === c}
              onChange={() => {
                setChoice(c);
                setKind(
                  c === "github" || c === "github_enterprise" ? "github_app" : "access_token",
                );
                setProblem({});
                edited();
              }}
            />
          ))}
        </ChoiceGroup>
        {choice !== "github" ? (
          <Field
            label="Address"
            required
            error={problem["address"]}
            hint={
              allowedHosts && allowedHosts.length > 0
                ? `The server's https web address. This Site allows: ${allowedHosts.join(", ")}.`
                : "The server's https web address, e.g. https://git.example.com."
            }
          >
            <TextInput
              type="url"
              inputMode="url"
              autoComplete="off"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                edited();
              }}
            />
          </Field>
        ) : null}
      </div>

      <div hidden={step !== 1} className="flex flex-col gap-3">
        <Field
          label={provider === "github" ? "Organization" : "Organization (or owner)"}
          required
          error={problem["organization"]}
          hint="Agents act only in this organization; everything else on the host stays out of reach."
        >
          <TextInput
            autoComplete="off"
            spellCheck={false}
            value={organization}
            onChange={(e) => {
              setOrganization(e.target.value);
              edited();
            }}
          />
        </Field>
        <ChoiceGroup legend="Access level" stacked>
          {ACCESS_LEVELS.map((l) => (
            <Radio
              key={l}
              name={`${ids}-level`}
              label={ACCESS_LABEL[l]}
              hint={ACCESS_HINT[l]}
              checked={level === l}
              onChange={() => {
                setLevel(l);
                edited();
              }}
            />
          ))}
        </ChoiceGroup>
        <CredentialFields
          ref={credential}
          provider={provider}
          kind={kind}
          onKindChange={setKind}
          onEdited={edited}
          disabled={pending}
        />
        <PermissionsHelp
          provider={provider}
          kind={kind}
          webBase={webBase()}
          organization={organization.trim()}
        />
      </div>

      <div hidden={step !== 2} className="flex flex-col gap-3">
        <p className="m-0 text-sm text-console-muted">
          Test reads the organization and lists what the credential may do, without saving anything.
          Connect tests again and stores the credential encrypted.
        </p>
        <div aria-live="polite" role="status" className="flex flex-col gap-2">
          {pending ? <p className="m-0 text-sm">Asking the host…</p> : null}
          {outcome?.kind === "error" ? (
            <Notice tone="error" role="none">
              <p className="m-0">{outcome.message}</p>
            </Notice>
          ) : null}
          {outcome?.kind === "report" ? (
            <TestReportView report={outcome.report} accessLevel={level} />
          ) : outcome?.kind === "error" && outcome.report ? (
            <TestReportView report={outcome.report} accessLevel={level} />
          ) : null}
        </div>
        <RepoDefaultsFields
          value={defaults}
          onChange={setDefaults}
          provider={provider}
          problems={problem}
          placeholderName={
            organization.trim()
              ? `${organization.trim()} on ${HOST_CHOICE_LABEL[choice].replace(" Enterprise Server", "")}`
              : ""
          }
        />
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        {step > 0 ? (
          <Button disabled={pending} onClick={() => setStep(step - 1)}>
            Back
          </Button>
        ) : null}
        {step < 2 ? (
          <Button type="submit" variant="primary">
            Next
          </Button>
        ) : (
          <>
            <Button disabled={pending} aria-busy={pending} onClick={() => void runTest()}>
              Test
            </Button>
            <Button variant="primary" disabled={pending || !passed} onClick={() => void connect()}>
              Connect
            </Button>
          </>
        )}
      </div>
      {step === 2 && !passed ? (
        <p className="m-0 mt-2 text-end text-sm text-console-muted">
          Connect is offered once a test passes.
        </p>
      ) : null}
    </form>
  );
}

function notAllowed(host: string): string {
  return `This Site does not allow git connections to ${host}. A Site admin can add it to the Site's allowed git hosts.`;
}
