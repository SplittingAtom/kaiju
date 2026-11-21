import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { logger } from "../logger.js";
import { createS3Client, type S3Settings } from "./s3.js";

/**
 * KOBE-738: Kobe deletes objects with plain DeleteObject. On a versioned bucket that only adds a
 * delete marker, and the bytes stay as a noncurrent version until a lifecycle rule expires them
 * (docs/install.md, "Object storage (S3)": NoncurrentVersionExpiration, 30 days recommended). At
 * start the server reads the bucket's versioning and lifecycle configuration and warns when
 * versioning is on (or suspended, with old versions kept) and no enabled rule expires noncurrent
 * versions of Kobe's objects. Providers that do not implement either call, or credentials not
 * allowed to read them, give no warning: the check is advisory and never stops the server.
 */

/** Longest the check waits for each call. */
export const BUCKET_CHECK_TIMEOUT_MS = 10_000;

export type BucketCheckSend = (
  command: GetBucketVersioningCommand | GetBucketLifecycleConfigurationCommand,
) => Promise<unknown>;

const errorName = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "name" in err
    ? String((err as { name: unknown }).name)
    : undefined;

/** The rule's key prefix when it filters by prefix only ("" = every object); null otherwise. */
function rulePrefix(rule: LifecycleRule): string | null {
  const filter = rule.Filter;
  if (filter === undefined) return rule.Prefix ?? "";
  if (filter.Tag || filter.And?.Tags?.length) return null;
  if (filter.ObjectSizeGreaterThan || filter.And?.ObjectSizeGreaterThan) return null;
  if (filter.ObjectSizeLessThan || filter.And?.ObjectSizeLessThan) return null;
  return filter.Prefix ?? filter.And?.Prefix ?? "";
}

/** Whether an enabled rule expires noncurrent versions of every object under `prefix`. */
export function expiresNoncurrentVersions(
  rules: readonly LifecycleRule[],
  prefix: string,
): boolean {
  return rules.some((rule) => {
    if (rule.Status !== "Enabled") return false;
    const days = rule.NoncurrentVersionExpiration?.NoncurrentDays;
    if (days === undefined || days <= 0) return false;
    const scope = rulePrefix(rule);
    return scope !== null && prefix.startsWith(scope);
  });
}

/** The warning to log, or undefined (no versioning, a rule in place, or nothing could be read). */
/** Where a skipped check is reported: the bucket name and the error's name only, never content. */
export type BucketCheckDebug = (
  fields: { readonly bucket: string; readonly call: string; readonly error: string },
  message: string,
) => void;

const defaultDebug: BucketCheckDebug = (fields, message) => logger.debug(fields, message);

export async function bucketLifecycleWarning(
  send: BucketCheckSend,
  bucket: string,
  prefix: string,
  debug: BucketCheckDebug = defaultDebug,
): Promise<string | undefined> {
  const skipped = (call: string, err: unknown): undefined => {
    debug({ bucket, call, error: errorName(err) ?? "unknown" }, "bucket lifecycle check skipped");
    return undefined;
  };
  let status: string | undefined;
  try {
    const versioning = (await send(new GetBucketVersioningCommand({ Bucket: bucket }))) as {
      Status?: string;
    };
    status = versioning.Status;
  } catch (err) {
    return skipped("GetBucketVersioning", err);
  }
  if (status !== "Enabled" && status !== "Suspended") return undefined;
  let rules: readonly LifecycleRule[];
  try {
    const lifecycle = (await send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    )) as { Rules?: LifecycleRule[] };
    rules = lifecycle.Rules ?? [];
  } catch (err) {
    if (errorName(err) !== "NoSuchLifecycleConfiguration") {
      return skipped("GetBucketLifecycleConfiguration", err);
    }
    rules = [];
  }
  if (expiresNoncurrentVersions(rules, prefix)) return undefined;
  return (
    `bucket versioning is ${status.toLowerCase()} and no lifecycle rule expires noncurrent ` +
    "versions: objects Kobe deletes stay in the bucket as noncurrent versions. Add a " +
    "NoncurrentVersionExpiration rule (30 days recommended; docs/install.md, Object storage)"
  );
}

/** The check against the configured store (one client, each call bounded); never throws. */
export async function checkBucketLifecycle(settings: S3Settings): Promise<string | undefined> {
  const client = createS3Client(settings);
  try {
    return await bucketLifecycleWarning(
      (command) =>
        client.send(command as GetBucketVersioningCommand, {
          abortSignal: AbortSignal.timeout(BUCKET_CHECK_TIMEOUT_MS),
        }),
      settings.bucket,
      settings.prefix,
    );
  } catch (err) {
    defaultDebug(
      { bucket: settings.bucket, call: "client", error: errorName(err) ?? "unknown" },
      "bucket lifecycle check skipped",
    );
    return undefined;
  } finally {
    client.destroy();
  }
}
