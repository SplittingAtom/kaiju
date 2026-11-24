import { MEMORY_EMBED_MAX_INPUT_CHARS } from "@kobe/protocol";

/**
 * Task prefixes per embedding model family (KOBE-409, KOBE-659 ledger), matched on the model id
 * after the gateway provider, so the same model behind any provider gets the same text.
 *
 * - Qwen3-Embedding takes an instruction on the query only (its model card); documents as is.
 * - nomic-embed-text: its card asks for `search_query: ` / `search_document: `, but on Kaiju's
 *   relevance set (docs/gates/gate-7b.md "Vectors (KOBE-409)") it ranks better without them, on
 *   both halves of the held-out split, so both sides are embedded as is (document scheme 2).
 * - Other models get the text as is.
 *
 * Changing how a family's documents are embedded makes its stored vectors stale: bump that
 * family's {@link DOCUMENT_SCHEME}. Vectors are stored under {@link storedVectorModel} (the
 * gateway model id plus `#d<scheme>` past scheme 1), so the old ones stop matching the query's,
 * count as not embedded in the Site console, and Build vectors re-embeds them. Query-only
 * changes need no bump.
 */
const QWEN3_QUERY =
  "Instruct: Given a message to an assistant, retrieve the remembered facts and preferences that help answer it\nQuery: ";

type Family = "nomic" | "qwen3" | "other";

/** How each family's documents are embedded; 1 is what the first KOBE-409 build stored. */
const DOCUMENT_SCHEME: Record<Family, number> = {
  // 1: `search_document: ` prefix; 2: as is (KOBE-409 tuning).
  nomic: 2,
  qwen3: 1,
  other: 1,
};

function family(model: string): Family {
  const name = model.slice(model.indexOf("/") + 1).toLowerCase();
  if (name.includes("nomic-embed")) return "nomic";
  if (name.includes("qwen3-embedding")) return "qwen3";
  return "other";
}

const cut = (prefix: string, text: string) =>
  prefix + text.slice(0, MEMORY_EMBED_MAX_INPUT_CHARS - prefix.length);

/** A memory statement as the model should embed it. */
export function documentText(_model: string, statement: string): string {
  // No family embeds documents with a prefix today (see DOCUMENT_SCHEME before adding one).
  return cut("", statement);
}

/** A run's message as the model should embed it for search. */
export function queryText(model: string, message: string): string {
  return cut(family(model) === "qwen3" ? QWEN3_QUERY : "", message);
}

/**
 * The `embedding_model` value a vector made by gateway model `model` is stored and matched under:
 * the model id, plus `#d<n>` once its family's document scheme is past 1.
 */
export function storedVectorModel(model: string): string {
  const scheme = DOCUMENT_SCHEME[family(model)];
  return scheme === 1 ? model : `${model}#d${scheme}`;
}
