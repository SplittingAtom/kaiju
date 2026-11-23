import { z } from "zod";
import { Envelope, type EnvelopeContext } from "../envelope/envelope.js";
import { GIT_CREDENTIAL_HINT_MAX, type GitCredentialKind } from "./types.js";

/**
 * The sealed credential of a git connection (KOBE-757, spec G8). Sealed with the site envelope
 * (KOBE-107) under its own kind, `git-hosts`, bound to the Workspace and the connection, so a
 * ciphertext copied into another connection, another Workspace or another kind of secret does not
 * open. It survives a rotation of the envelope key: a previous key still opens it, and
 * {@link rewrapGitCredential} moves it to the current key without decrypting the data.
 *
 * Only the server and the egress proxy ever open it, for one call at a time. It is never returned
 * by an API, logged, audited, or sent to a sandbox, a browser or a model.
 */
export const GIT_CREDENTIAL_ENVELOPE_KIND = "git-hosts";

/** Longest access token accepted (GitHub fine-grained tokens are ~93 characters). */
export const GIT_ACCESS_TOKEN_MAX = 1024;
/** Longest GitHub App private key accepted (PEM; a 4096-bit RSA key is ~3.3 KB). */
export const GIT_APP_PRIVATE_KEY_MAX = 8192;

/** The plaintext secret behind a connection's credential, by credential kind. */
export const gitCredentialSecretSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("access_token"),
    /** Visible ASCII, no spaces (any of the hosts' token formats). */
    token: z
      .string()
      .min(1)
      .max(GIT_ACCESS_TOKEN_MAX)
      .regex(/^[\x21-\x7e]+$/),
  }),
  z.strictObject({
    kind: z.literal("github_app"),
    /** The App's PEM private key (G5); App ID and installation ID are stored in clear. */
    privateKey: z
      .string()
      .min(1)
      .max(GIT_APP_PRIVATE_KEY_MAX)
      .regex(/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----\s*$/),
  }),
]);
export type GitCredentialSecret = z.infer<typeof gitCredentialSecretSchema>;

/** The connection a credential belongs to (what the ciphertext is bound to). */
export interface GitCredentialRef {
  readonly teamId: string;
  readonly connectionId: string;
}

export class GitCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCredentialError";
  }
}

export function gitCredentialContext(ref: GitCredentialRef): EnvelopeContext {
  return { teamId: ref.teamId, kind: GIT_CREDENTIAL_ENVELOPE_KIND, recordId: ref.connectionId };
}

/** The columns to store: the envelope text and its key id. */
export interface SealedGitCredential {
  readonly credentialSealed: string;
  readonly credentialKeyId: string;
}

/** Validates and seals `secret` for the connection. Errors never include the secret. */
export function sealGitCredential(
  envelope: Envelope,
  ref: GitCredentialRef,
  secret: GitCredentialSecret,
): SealedGitCredential {
  const parsed = gitCredentialSecretSchema.safeParse(secret);
  if (!parsed.success) throw new GitCredentialError("the git credential has an invalid shape");
  const sealed = envelope.seal(JSON.stringify(parsed.data), gitCredentialContext(ref));
  return { credentialSealed: sealed, credentialKeyId: Envelope.keyIdOf(sealed) };
}

/**
 * Opens a stored credential for one use. `expectedKind` is the row's `credential_kind`: a sealed
 * value of the other kind is refused. Throws (fixed messages) on a wrong key, context or shape.
 */
export function openGitCredential(
  envelope: Envelope,
  ref: GitCredentialRef,
  sealed: string,
  expectedKind: GitCredentialKind,
): GitCredentialSecret {
  let json: unknown;
  try {
    json = JSON.parse(envelope.openString(sealed, gitCredentialContext(ref)));
  } catch {
    throw new GitCredentialError("the git credential does not open");
  }
  const parsed = gitCredentialSecretSchema.safeParse(json);
  if (!parsed.success || parsed.data.kind !== expectedKind) {
    throw new GitCredentialError("the stored git credential has an invalid shape");
  }
  return parsed.data;
}

/** Re-wraps a stored credential with the current envelope key (rotation); data unchanged. */
export function rewrapGitCredential(
  envelope: Envelope,
  ref: GitCredentialRef,
  sealed: string,
): SealedGitCredential {
  const next = envelope.rewrap(sealed, gitCredentialContext(ref));
  return { credentialSealed: next, credentialKeyId: Envelope.keyIdOf(next) };
}

/** The masked hint shown for an access token (last 4 characters); none for an App. */
export function gitCredentialHint(secret: GitCredentialSecret): string | null {
  if (secret.kind !== "access_token") return null;
  const tail = secret.token.length > 12 ? secret.token.slice(-4) : "";
  return `••••${tail}`.slice(0, GIT_CREDENTIAL_HINT_MAX);
}
