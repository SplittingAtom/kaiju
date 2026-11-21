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

- **Unfinished uploads** (a file or a skill upload that never finished, for example after a
  crash) are removed by the nightly clean-up once they are a day old.

A legal hold keeps everything it covers until it is released. A hold on you in any workspace also
keeps your unfinished personal skill uploads, since a personal skill belongs to no workspace; they
are removed by a later clean-up once no hold names you.

## When the bytes are gone

A deletion removes the data at once from Kobe and its database. File contents in the site's object
storage are removed by Kobe's nightly clean-up, so within about a day; longer if the clean-up
falls behind or the site's operators have paused it (for example after restoring a backup). Many
sites keep that storage versioned, so files deleted by mistake can be recovered: there, deleted
contents stay recoverable by the site's operators for a set period after that (Kobe recommends
**30 days**; ask them which applies), then are erased.
