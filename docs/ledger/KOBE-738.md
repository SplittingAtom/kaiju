# KOBE-738: Object storage docs: lifecycle rules, versioning and object lock; bucket check (STO-6)

- **Status:** in review (group 60)
- **Branch / worktree:** `group-60-storage-ops` in `../Kobe-g60`
- **Depends on:** none

## Decisions

- Owner decisions (Chris, 2026-11-20) applied as written: versioning recommended with
  `NoncurrentVersionExpiration` 30 days (operator may change; it is then the erasure delay),
  `ExpiredObjectDeleteMarker`, `AbortIncompleteMultipartUpload` (3 days); object lock governance
  mode only, no longer than the noncurrent period; compliance mode advised against.
- **Bucket check: done, log only.** `workspace-sync/bucket-check.ts`: at server start, in the
  background, `GetBucketVersioning`; when Enabled or Suspended, `GetBucketLifecycleConfiguration`
  (`NoSuchLifecycleConfiguration` = no rules); warns unless an enabled rule with
  `NoncurrentDays` covers Kobe's `s3.prefix` (prefix-only filters; tag or size filters do not
  count). Any other error (NotImplemented, AccessDenied, timeout 10 s) gives no warning. No Site
  console notice: that needs a health route and UI, not small; the log line is documented.
- Guide: there was no retention page, so `docs/guide/reference/retention-and-deletion.md` is new
  (what Kobe deletes and when, and the storage erasure delay on a versioned bucket). Kept short:
  the whole guide must stay under the `docs_full` cap (256 KiB, `kobe-mcp/docs`); with this page
  it is 261,576 of 262,144 bytes, so the next guide addition needs the cap raised or text cut.

## Docs

`docs/install.md` (Object storage: versioning, lifecycle table and example, startup warning,
object lock), `docs/backup-restore.md` (Object storage: versioning with lifecycle, trade-off,
object lock), guide `reference/retention-and-deletion.md`.

## Evidence

- ac-1: install.md and backup-restore.md sections above.
- ac-2: guide page "When the bytes are gone".
- ac-3: decided by Chris 2026-11-20 (coordinator log).
- Check: `services/server/src/workspace-sync/bucket-check.test.ts` (warns with versioning and no
  expiry, Suspended, no lifecycle configuration; quiet with a covering rule or no versioning;
  tolerates NotImplemented and AccessDenied; rule matching by status, days, prefix, tag filter).
