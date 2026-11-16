import type { SemanticMemoryScope } from "@kobe/protocol";

/**
 * The saved memories each run's `recall` answers named (KOBE-399), per sandbox connection, so
 * `show_memory_item` accepts those ids besides the run's own records. In memory and bounded: the
 * oldest entries go first, and a lost entry (eviction, a new connection or server) only means the
 * agent must recall the item again (fail closed). Never an authority on its own: the item is read
 * again under the runner's RLS and owner filters when shown.
 */
export const RECALLED_MAX = 4096;

export class RecalledItems {
  readonly #entries = new Map<string, SemanticMemoryScope>();
  readonly #max: number;

  constructor(max = RECALLED_MAX) {
    this.#max = max;
  }

  #key(runId: string, id: string): string {
    return `${runId}:${id}`;
  }

  add(runId: string, items: readonly { id: string; scope: SemanticMemoryScope }[]): void {
    for (const item of items) {
      const key = this.#key(runId, item.id);
      this.#entries.delete(key);
      this.#entries.set(key, item.scope);
      if (this.#entries.size > this.#max) {
        const oldest = this.#entries.keys().next().value;
        if (oldest !== undefined) this.#entries.delete(oldest);
      }
    }
  }

  scopeOf(runId: string, id: string): SemanticMemoryScope | undefined {
    return this.#entries.get(this.#key(runId, id));
  }
}
