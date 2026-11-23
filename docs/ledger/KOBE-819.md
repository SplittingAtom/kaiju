# KOBE-819: Bell notifications for Repo conversion finished or failed and for a Git connection's token nearing expiry

- **Status:** in review (committed on the branch, not pushed; the coordinator lands it)
- **Branch / worktree:** `group-115-git-bell` in `../Kobe-g115`, stacked on `group-114-split-tests`
  (← `group-113-test-folders` ← `group-112-typed-lint`)
- **Depends on:** KOBE-765 (conversion job), KOBE-760 (token-expiry job), KOBE-768 (Files panel notices)

## What ships

| Piece                                                                                                                                                                                                                                                                                                                                                                                                         | Where                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kinds `git.conversion.completed`, `git.conversion.failed`, `git.connection.token_expiring`; fields `git_conversion_id`, `project_name`, `git_repository`, `git_failure`, `git_failure_message`, `git_connection_id`, `git_connection_name`, `git_expires_at` (`project_id` reused); `gitNotificationFields`                                                                                                   | `packages/protocol/src/notifications.ts`                                                                                                                                              |
| Migration **0259_git_notifications**: columns `git_conversion_id`, `git_attempt`, `git_failure`, `git_connection_id`, `git_expires_at` on `notifications`; FKs (team_id, …) → `git_conversions` / `git_connections` ON DELETE CASCADE; CHECK `notifications_git`; widened `notifications_kind` and `notifications_shape`; unique indexes `notifications_git_conversion_uniq`, `notifications_git_expiry_uniq` | `packages/db/src/schema/schedule-notifications.ts`, `packages/db/drizzle/0259_*`                                                                                                      |
| Conversion writer (savepoint in the end's transaction)                                                                                                                                                                                                                                                                                                                                                        | `services/server/src/git/conversion/bell.ts`, called from `runner.ts` (finish, failure) and `store.ts` (poison guard)                                                                 |
| Expiry writer (in the claim's transaction, savepoint)                                                                                                                                                                                                                                                                                                                                                         | `services/server/src/git/expiry-notify.ts`                                                                                                                                            |
| Listing (names joined at read time, failure words from `FAILURE_MESSAGES`)                                                                                                                                                                                                                                                                                                                                    | `services/server/src/notifications/store.ts`                                                                                                                                          |
| Bell: titles, failure reason line, labels, **Show in Files** / **Open the Git section**                                                                                                                                                                                                                                                                                                                       | `apps/web/lib/notifications/format.ts`, `components/chat/notification-bell.tsx`, `lib/shell/files-request.ts`, `components/shell/app-commands.tsx`, `utility-bar.tsx`, `chat-app.tsx` |

## Decisions

- **No second mechanism:** the existing `notifications` table, `/v1/notifications` route and bell.
  No audit events added (the conversion and expiry already audit; the bell is not a decision).
- **Recipients.** Conversion: `requested_by`, only while an active member of the Workspace (same
  rule as the email; not re-checked against project roles). Expiry: every active `team_admin` at
  the moment of the claim; an admin who lost the role meanwhile gets nothing new (old notices stay
  theirs until read and swept, as for every kind).
- **Exactly once.** Conversion: written inside the transaction that records the end (lease-guarded
  `updateHeld`, or the poison guard's claim), so only the replica that ends it writes it; plus a
  unique index on (team, conversion, kind, `git_attempt` = `attempts` at the end) and `ON CONFLICT
DO NOTHING`. A person's retry that fails again is a new end (a new claim increments `attempts`)
  and is told again. Expiry: the email's claim (`expiry_notified_at`, once per credential) decides;
  unique (team, connection, admin, expiry) keeps a repeated claim for the same expiry from doubling.
- **Failure isolation:** both writers run in a savepoint (as `notifyScheduledRunEndInTx`); an
  error is logged and rolls back only the notification. Tested with a trigger that refuses inserts.
- **"Once per threshold"** = the email's single threshold (14 days, `GIT_EXPIRY_NOTICE_DAYS`), once
  per credential; one kind, the web says "expires on" or "expired on" (expiry vs. notice time).
- \* **Expiry claims no longer need a mail relay.** Before, a process with `mailer.disabled` claimed
  nothing ("leaves notices to one that has one"). The bell needs no relay, so it now claims and
  writes the bell notice and sends no email. Owner please confirm: a Site without mail that turns
  mail on later won't get emails for credentials already noticed in the bell.
- **Text safety:** the row stores ids, the claim count and the failure _code_; names are joined at
  read time; the failure words are `FAILURE_MESSAGES[code]` (what the dialog shows). The stored
  `last_error_detail` (may quote the host) is never sent. No token, hint or host body.
- \* **"Show in Files"** reveals the Files panel (rail) through a window event (the bell sits outside
  the workspace's rail provider) and closes a panel first. It does not yet scroll to or expand the
  project row; the Repo row and its **Convert to repo…** are there.
- Rows cascade with their conversion (i.e. the project) or connection; they never outlive what
  they name. Protocol contract changed inside this feature PR because the ticket requires it.

## Doc evaluation

Updated `docs/guide/files/workspaces-and-projects.md` (Notices, conversion paragraph),
`admin/git-organizations.md` (token expiry), `getting-started/layout.md` (Notifications),
`whats-new.md` (v1.4). No "For agents" change: agents in the sandbox never see the bell.

## Evidence

- ac-1: `services/server/src/git/conversion-bell.db.test.ts` (finish, failed ×2 then finish,
  poison guard, deactivated requester, racing writes, refused insert).
- ac-2: `services/server/src/git/team-git.db.test.ts` "token-expiry bell notifications (KOBE-819)".
- ac-3: `packages/db/src/git-notifications.db.test.ts`, `packages/protocol/src/notifications.test.ts`,
  `services/server/src/git/conversion/bell.test.ts`, `apps/web/lib/notifications/format.test.ts`,
  `apps/web/components/chat/notification-bell.test.tsx`, `apps/web/lib/shell/files-request.test.ts`.
- Suites: see the commit / report (counts).
