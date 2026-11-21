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

A legal hold keeps everything it covers until it is released.

## When the bytes are gone

A deletion removes the data at once from Kobe and its database, and file contents from the site's
object storage. Many sites keep that storage versioned, so files deleted by mistake can be
recovered: there, deleted contents stay recoverable by the site's operators for a set period
(Kobe recommends **30 days**; ask them which applies), then are erased. Without versioning they
are erased at once.
