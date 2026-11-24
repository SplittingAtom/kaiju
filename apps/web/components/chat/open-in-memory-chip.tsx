"use client";

/**
 * The "Open in Memory" chip under a `show_memory_item` call (KOBE-399, SM26): the agent showed the
 * person one saved memory, and this links to it on the My memory page, where Archive and Undo
 * live. Only once the call succeeded (the server answers only for a memory the run was given or
 * recalled); the id comes from the call's input and must be a UUID, so the link is always a plain
 * address in this app. The page reads the memory again under the viewer's own access.
 */
import { BrainIcon } from "lucide-react";
import { IconAction } from "../shell/icon-action";
import { isUuid } from "../../lib/memory/ids";
import { memoryItemHref } from "../../lib/memory/tabs";
import styles from "./chat.module.css";

export function OpenInMemoryChip({
  args,
  done,
  failed,
}: {
  /** The call's input: `{ id }`. */
  readonly args: unknown;
  readonly done: boolean;
  /** The call failed or was denied: there is nothing to open. */
  readonly failed: boolean;
}) {
  const id = (args as { id?: unknown } | undefined)?.id;
  if (!done || failed || typeof id !== "string" || !isUuid(id)) return null;
  return (
    <div className={`${styles.fileCard} kaiju-panel`} data-kaiju-memory-item={id}>
      <BrainIcon aria-hidden className="size-4" />
      <div className={styles.fileInfo}>
        <span className={styles.fileName}>Saved memory</span>
      </div>
      <IconAction
        command="my-memory"
        label="Open in Memory"
        href={memoryItemHref(id)}
        shortcut={null}
        size="sm"
      />
    </div>
  );
}
