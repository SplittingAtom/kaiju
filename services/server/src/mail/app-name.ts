import { APP_NAME_MAX_LENGTH, DEFAULT_APP_NAME } from "@kaiju/protocol";
import type { KaijuDb, KaijuTx } from "@kaiju/db";
import { readAppName } from "../branding/settings.js";

/**
 * The Site's app name as email subjects and bodies use it (KOBE-834). The stored name is already
 * validated (`appNameSchema`), but a header is no place to trust it: control, format and
 * line/paragraph separator characters become spaces (no CR/LF header injection, no bidi tricks),
 * runs of white space collapse, and the result is cut to the name's own cap in code points (never
 * splitting a surrogate pair). Empty after that, it is the default name.
 */
export function mailAppName(raw: string | null | undefined): string {
  const flat = (raw ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = [...flat];
  const name = points.length > APP_NAME_MAX_LENGTH ? points.slice(0, APP_NAME_MAX_LENGTH) : points;
  const capped = name.join("").trim();
  return capped === "" ? DEFAULT_APP_NAME : capped;
}

/** Reads the Site's app name once (for a whole send, not per recipient), ready for mail. */
export async function readMailAppName(db: KaijuDb | KaijuTx): Promise<string> {
  return mailAppName(await readAppName(db));
}

/**
 * Reads the app name at most once for many sends started apart (one background task per
 * recipient): the first caller reads it, the others share that read. A failed read is not kept.
 */
export function appNameOnce(db: KaijuDb | KaijuTx): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= readMailAppName(db).catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}
