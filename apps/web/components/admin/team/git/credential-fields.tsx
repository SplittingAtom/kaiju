"use client";

import { forwardRef, useId, useImperativeHandle, useRef, useState, type ChangeEvent } from "react";
import type {
  GitCredentialInput,
  GitCredentialKind,
  GitProvider,
} from "../../../../lib/admin/api/team/git";
import { ChoiceGroup, Field, Radio, Textarea, TextInput } from "../../../ui/console";

/** The server's limits (`GIT_ACCESS_TOKEN_MAX`, `GIT_APP_PRIVATE_KEY_MAX`). */
const TOKEN_MAX = 1024;
const KEY_MAX = 8192;
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;
const ID_SHAPE = /^[1-9]\d{0,15}$/;
/** Refused before anything is sent (the server takes 8 KiB keys in requests of at most 64 KiB). */
const KEY_TOO_LONG =
  "That is too long for a private key: Kaiju accepts up to 8 KiB (a GitHub App key is about 2 KiB). Use the .pem file GitHub generated.";

/**
 * Reads the credential at submit time (the only moment it leaves the form) and wipes it. The
 * secret parts (token, private key) are uncontrolled inputs: they live in the DOM field alone,
 * never in React state or props, so nothing re-renders them, React never mirrors them into a
 * `value` attribute, and closing the dialog (which unmounts the fields) drops them.
 */
export interface CredentialHandle {
  readonly read: () => GitCredentialInput | null;
  readonly clear: () => void;
}

interface Problems {
  readonly token?: string | undefined;
  readonly appId?: string | undefined;
  readonly githubInstallationId?: string | undefined;
  readonly privateKey?: string | undefined;
}

/**
 * Keeps browsers and password managers away from a secret field: no saving, no filling, no
 * spelling or capitalisation help (which can send the text elsewhere).
 */
const SECRET_FIELD = {
  autoComplete: "new-password",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true,
  "data-form-type": "other",
} as const;

/** Masks a textarea's characters like a password field (a PEM key needs its line breaks). */
const MASKED = "[-webkit-text-security:disc] font-mono";

export const CredentialFields = forwardRef<
  CredentialHandle,
  {
    readonly provider: GitProvider;
    readonly kind: GitCredentialKind;
    readonly onKindChange: (kind: GitCredentialKind) => void;
    /** Anything changed: a test made with the old values no longer counts. */
    readonly onEdited: () => void;
    readonly disabled?: boolean;
  }
>(function CredentialFields({ provider, kind, onKindChange, onEdited, disabled = false }, ref) {
  const ids = useId();
  const token = useRef<HTMLInputElement>(null);
  const key = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  // The App's two ids are not secret (the admin view shows them): ordinary state.
  const [appIds, setAppIds] = useState({ appId: "", githubInstallationId: "" });
  const { appId, githubInstallationId } = appIds;
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problems>({});

  useImperativeHandle(
    ref,
    () => ({
      read() {
        if (kind === "access_token") {
          const value = (token.current?.value ?? "").trim();
          const problem =
            value === ""
              ? "Paste the access token."
              : value.length > TOKEN_MAX || !TOKEN_SHAPE.test(value)
                ? "That is not an access token: paste it without spaces or line breaks."
                : undefined;
          setProblems(problem ? { token: problem } : {});
          return problem ? null : { kind: "access_token", token: value };
        }
        const pem = (key.current?.value ?? "").trim();
        const next: {
          appId?: string;
          githubInstallationId?: string;
          privateKey?: string;
        } = {};
        if (!ID_SHAPE.test(appId.trim())) next.appId = "Enter the App ID (a number).";
        if (!ID_SHAPE.test(githubInstallationId.trim())) {
          next.githubInstallationId = "Enter the installation ID (a number).";
        }
        if (pem === "")
          next.privateKey = "Add the App's private key (paste it or choose the file).";
        else if (pem.length > KEY_MAX) next.privateKey = KEY_TOO_LONG;
        else if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
          next.privateKey = "That is not a private key: use the .pem file GitHub generated.";
        } else if (pem.includes("ENCRYPTED PRIVATE KEY")) {
          next.privateKey = "An encrypted key cannot be used: use the key as GitHub hands it out.";
        }
        setProblems(next);
        if (Object.keys(next).length > 0) return null;
        return {
          kind: "github_app",
          app_id: Number(appId.trim()),
          installation_id: Number(githubInstallationId.trim()),
          private_key: pem,
        };
      },
      clear() {
        if (token.current) token.current.value = "";
        if (key.current) key.current.value = "";
        if (file.current) file.current.value = "";
        setKeyFile(null);
      },
    }),
    [kind, appId, githubInstallationId],
  );

  async function loadKey(e: ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0];
    e.target.value = "";
    if (!chosen) return;
    if (chosen.size > KEY_MAX) {
      setProblems((p) => ({ ...p, privateKey: KEY_TOO_LONG }));
      return;
    }
    const text = await chosen.text();
    if (key.current) key.current.value = text;
    setKeyFile(chosen.name);
    setProblems((p) => ({ ...p, privateKey: undefined }));
    onEdited();
  }

  return (
    <div className="flex flex-col gap-3">
      {provider === "github" ? (
        <ChoiceGroup legend="Credential" stacked>
          <Radio
            name={`${ids}-kind`}
            label="GitHub App (recommended)"
            hint="No user account used; removing the App's installation revokes access at once."
            checked={kind === "github_app"}
            disabled={disabled}
            onChange={() => {
              onKindChange("github_app");
              onEdited();
            }}
          />
          <Radio
            name={`${ids}-kind`}
            label="Fine-grained personal access token"
            hint="Actions appear as the token's owner."
            checked={kind === "access_token"}
            disabled={disabled}
            onChange={() => {
              onKindChange("access_token");
              onEdited();
            }}
          />
        </ChoiceGroup>
      ) : null}
      {kind === "access_token" ? (
        <Field
          id={`${ids}-token`}
          label="Access token"
          required
          error={problems.token}
          hint="Stored encrypted. Never shown again, not even to you."
        >
          <TextInput
            ref={token}
            type="password"
            name="git-access-token"
            {...SECRET_FIELD}
            disabled={disabled}
            onInput={onEdited}
          />
        </Field>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <Field id={`${ids}-app`} label="App ID" required error={problems.appId}>
              <TextInput
                inputMode="numeric"
                autoComplete="off"
                className="w-36"
                value={appId}
                disabled={disabled}
                onChange={(e) => {
                  setAppIds((v) => ({ ...v, appId: e.target.value }));
                  onEdited();
                }}
              />
            </Field>
            <Field
              id={`${ids}-installation`}
              label="Installation ID"
              required
              error={problems.githubInstallationId}
            >
              <TextInput
                inputMode="numeric"
                autoComplete="off"
                className="w-36"
                value={githubInstallationId}
                disabled={disabled}
                onChange={(e) => {
                  setAppIds((v) => ({ ...v, githubInstallationId: e.target.value }));
                  onEdited();
                }}
              />
            </Field>
          </div>
          <Field
            id={`${ids}-key`}
            label="Private key"
            required
            error={problems.privateKey}
            hint={
              keyFile
                ? `Loaded from ${keyFile}. Stored encrypted; never shown again.`
                : "Choose the .pem file GitHub generated, or paste it. Stored encrypted; never shown again."
            }
          >
            <Textarea
              ref={key}
              name="git-private-key"
              {...SECRET_FIELD}
              rows={4}
              className={MASKED}
              disabled={disabled}
              onInput={(e) => {
                setKeyFile(null);
                // Said at once, not only at submit: a pasted file of the wrong kind is obvious.
                const tooLong = e.currentTarget.value.length > KEY_MAX;
                setProblems((p) => ({ ...p, privateKey: tooLong ? KEY_TOO_LONG : undefined }));
                onEdited();
              }}
            />
          </Field>
          <label className="text-sm">
            <span className="me-2">Private key file</span>
            <input
              ref={file}
              type="file"
              accept=".pem,application/x-pem-file,text/plain"
              disabled={disabled}
              onChange={(e) => void loadKey(e)}
            />
          </label>
        </>
      )}
    </div>
  );
});
