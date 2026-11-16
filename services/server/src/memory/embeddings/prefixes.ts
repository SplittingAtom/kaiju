import { MEMORY_EMBED_MAX_INPUT_CHARS } from "@kobe/protocol";

/**
 * Task prefixes some embedding models expect (KOBE-409, KOBE-659 ledger): nomic-embed-text
 * embeds `search_document: ` texts and `search_query: ` queries; Qwen3-Embedding takes an
 * instruction on the query only. Other models get the text as is. Matched on the model id after
 * the gateway provider, so the same model behind any provider gets the same prefixes.
 */
const QWEN3_QUERY =
  "Instruct: Given a message to an assistant, retrieve the remembered facts and preferences that help answer it\nQuery: ";

function family(model: string): "nomic" | "qwen3" | "other" {
  const name = model.slice(model.indexOf("/") + 1).toLowerCase();
  if (name.includes("nomic-embed")) return "nomic";
  if (name.includes("qwen3-embedding")) return "qwen3";
  return "other";
}

const cut = (prefix: string, text: string) =>
  prefix + text.slice(0, MEMORY_EMBED_MAX_INPUT_CHARS - prefix.length);

/** A memory statement as the model should embed it. */
export function documentText(model: string, statement: string): string {
  return cut(family(model) === "nomic" ? "search_document: " : "", statement);
}

/** A run's message as the model should embed it for search. */
export function queryText(model: string, message: string): string {
  const f = family(model);
  return cut(f === "nomic" ? "search_query: " : f === "qwen3" ? QWEN3_QUERY : "", message);
}
