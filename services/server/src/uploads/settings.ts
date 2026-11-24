import { z } from "zod";
import {
  PROJECT_HISTORY_MAX_COMMITS,
  UPLOAD_DEFAULT_MAX_FILE_BYTES,
  UPLOAD_DEFAULT_MAX_MESSAGE_BYTES,
} from "@kaiju/protocol";

const GIB = 1024 * 1024 * 1024;

/** Default per-team storage quota when the team has none of its own (D26). */
export const DEFAULT_TEAM_STORAGE_QUOTA_BYTES = 50 * GIB;
/** Default object budget per team when it has none of its own (Workspaces GV2, KOBE-579). */
export const DEFAULT_TEAM_MAX_OBJECTS = 2_000_000;
/** How long an upload that never joined a thread is kept (hours). */
export const DEFAULT_ORPHAN_HOURS = 24;

const bytes = (name: string) =>
  z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .min(1, `${name} must be at least 1`)
    .max(Number.MAX_SAFE_INTEGER, `${name} is too large`);

/** Defaults for the optional clamd connection (chart `clamav.*`). */
export const DEFAULT_CLAMD_PORT = 3310;
export const DEFAULT_CLAMD_TIMEOUT_MS = 60_000;

const schema = z.object({
  /** Set by the chart when `clamav.enabled`; absent = no scanning. */
  KAIJU_CLAMAV_HOST: z.string().trim().min(1, "KAIJU_CLAMAV_HOST must not be empty").optional(),
  KAIJU_CLAMAV_PORT: z.coerce
    .number({ error: "KAIJU_CLAMAV_PORT must be a number" })
    .int("KAIJU_CLAMAV_PORT must be an integer")
    .min(1, "KAIJU_CLAMAV_PORT must be a port")
    .max(65535, "KAIJU_CLAMAV_PORT must be a port")
    .default(DEFAULT_CLAMD_PORT),
  KAIJU_CLAMAV_TIMEOUT_MS: z.coerce
    .number({ error: "KAIJU_CLAMAV_TIMEOUT_MS must be a number" })
    .int("KAIJU_CLAMAV_TIMEOUT_MS must be an integer")
    .min(1000, "KAIJU_CLAMAV_TIMEOUT_MS must be between 1000 and 600000")
    .max(600_000, "KAIJU_CLAMAV_TIMEOUT_MS must be between 1000 and 600000")
    .default(DEFAULT_CLAMD_TIMEOUT_MS),
  KAIJU_UPLOAD_MAX_FILE_BYTES: bytes("KAIJU_UPLOAD_MAX_FILE_BYTES").default(
    UPLOAD_DEFAULT_MAX_FILE_BYTES,
  ),
  KAIJU_UPLOAD_MAX_MESSAGE_BYTES: bytes("KAIJU_UPLOAD_MAX_MESSAGE_BYTES").default(
    UPLOAD_DEFAULT_MAX_MESSAGE_BYTES,
  ),
  KAIJU_TEAM_STORAGE_QUOTA_BYTES: bytes("KAIJU_TEAM_STORAGE_QUOTA_BYTES").default(
    DEFAULT_TEAM_STORAGE_QUOTA_BYTES,
  ),
  KAIJU_TEAM_MAX_OBJECTS: bytes("KAIJU_TEAM_MAX_OBJECTS").default(DEFAULT_TEAM_MAX_OBJECTS),
  KAIJU_PROJECT_HISTORY_MAX_COMMITS: z.coerce
    .number({ error: "KAIJU_PROJECT_HISTORY_MAX_COMMITS must be a number" })
    .int("KAIJU_PROJECT_HISTORY_MAX_COMMITS must be an integer")
    .min(1, "KAIJU_PROJECT_HISTORY_MAX_COMMITS must be between 1 and 100000")
    .max(100_000, "KAIJU_PROJECT_HISTORY_MAX_COMMITS must be between 1 and 100000")
    .default(PROJECT_HISTORY_MAX_COMMITS),
  KAIJU_UPLOAD_ORPHAN_HOURS: z.coerce
    .number({ error: "KAIJU_UPLOAD_ORPHAN_HOURS must be a number" })
    .int("KAIJU_UPLOAD_ORPHAN_HOURS must be an integer")
    .min(1, "KAIJU_UPLOAD_ORPHAN_HOURS must be between 1 and 720")
    .max(720, "KAIJU_UPLOAD_ORPHAN_HOURS must be between 1 and 720")
    .default(DEFAULT_ORPHAN_HOURS),
});

export interface UploadSettings {
  /** Largest single file (`file_too_large`). */
  readonly maxFileBytes: number;
  /** Largest message total (`message_too_large`); also bounds a single file. */
  readonly maxMessageBytes: number;
  /** Team storage limit when `team_storage_quotas` has no value for the team. */
  readonly defaultQuotaBytes: number;
  /** Hours before an upload without a thread is deleted. */
  readonly orphanHours: number;
  /** Object budget when `team_storage_quotas.max_objects` is null (GV2); default 2 000 000. */
  readonly defaultMaxObjects?: number;
  /** Hard cap of commits kept per project (GV2/GV3, `PROJECT_HISTORY_MAX_COMMITS`). */
  readonly projectHistoryMaxCommits?: number;
  /**
   * clamd to scan every upload with (KOBE-146). Absent: scanning is off (`scan: skipped`). When
   * present the scan fails closed: clamd unreachable = `scan_unavailable`, never an unscanned file.
   */
  readonly clamav?: { readonly host: string; readonly port: number; readonly timeoutMs: number };
}

export const DEFAULT_UPLOAD_SETTINGS: UploadSettings = {
  maxFileBytes: UPLOAD_DEFAULT_MAX_FILE_BYTES,
  maxMessageBytes: UPLOAD_DEFAULT_MAX_MESSAGE_BYTES,
  defaultQuotaBytes: DEFAULT_TEAM_STORAGE_QUOTA_BYTES,
  orphanHours: DEFAULT_ORPHAN_HOURS,
  defaultMaxObjects: DEFAULT_TEAM_MAX_OBJECTS,
  projectHistoryMaxCommits: PROJECT_HISTORY_MAX_COMMITS,
};

/** Upload limits from the environment (Helm); invalid values fail the start, naming the variable. */
export function loadUploadSettings(
  env: Readonly<Record<string, string | undefined>>,
): UploadSettings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    maxFileBytes: e.KAIJU_UPLOAD_MAX_FILE_BYTES,
    maxMessageBytes: e.KAIJU_UPLOAD_MAX_MESSAGE_BYTES,
    defaultQuotaBytes: e.KAIJU_TEAM_STORAGE_QUOTA_BYTES,
    orphanHours: e.KAIJU_UPLOAD_ORPHAN_HOURS,
    defaultMaxObjects: e.KAIJU_TEAM_MAX_OBJECTS,
    projectHistoryMaxCommits: e.KAIJU_PROJECT_HISTORY_MAX_COMMITS,
    ...(e.KAIJU_CLAMAV_HOST
      ? {
          clamav: {
            host: e.KAIJU_CLAMAV_HOST,
            port: e.KAIJU_CLAMAV_PORT,
            timeoutMs: e.KAIJU_CLAMAV_TIMEOUT_MS,
          },
        }
      : {}),
  };
}
