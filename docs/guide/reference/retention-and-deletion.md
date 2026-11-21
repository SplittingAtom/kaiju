---
title: Retention and deletion
summary: When Kobe deletes threads and memories, and how long deleted file contents can stay in the site's storage.
section: Reference
order: 4
audience: member
---

## What Kobe deletes, and when

- **Threads you delete** go to Trash and are deleted for good after 30 days, or at once with
  **Delete forever** (see [Threads](../chat/threads-panel.md#archive-delete-and-restore)).
- **Threads past the workspace's retention period** are deleted for good; your team admin sets it.
- **Memories** follow that period too (see [Memory](../memory.md#how-long-memories-are-kept)).

- **Housekeeping records** go after periods your install admin sets (chart `retention.sweeps`):
  processed background events after 30 days (never pending work or a schedule's latest run), read
  notifications after 180 days (unread ones stay), per-call model usage after 13 months (so the
  Usage pages show at most that far back; the daily spend totals budgets count stay), and finished
  agent evals after 12 months (each agent's latest and those that published a version stay). The
  audit log is never swept.
- **A sandbox's volume** may be freed after it has slept a long time, if your site turns this on
  (see [Storage limits](../files/storage-limits.md#when-your-volume-is-reclaimed)).

A legal hold keeps everything it covers until it is released.

## When the bytes are gone

A deletion removes the data at once from Kobe and its database. File contents in the site's object
storage are removed by Kobe's nightly clean-up, so within about a day; longer if the clean-up
falls behind or the site's operators have paused it (for example after restoring a backup). Many
sites keep that storage versioned, so files deleted by mistake can be recovered: there, deleted
contents stay recoverable by the site's operators for a set period after that (Kobe recommends
**30 days**; ask them which applies), then are erased.
