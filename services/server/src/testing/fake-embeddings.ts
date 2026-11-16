/**
 * A deterministic stand-in for an embedding model (KOBE-409 tests): one dimension per concept,
 * counted from words that mean it, plus a small constant so no vector is zero. "car" and
 * "automobile" land close although they share no word, which is what the vector leg adds.
 */
const CONCEPTS: readonly (readonly string[])[] = [
  ["car", "cars", "automobile", "vehicle", "drive", "electric", "garage", "parking"],
  ["invoice", "invoices", "money", "budget", "pay", "salary", "fiscal", "billing", "cost"],
  ["rain", "rains", "weather", "spring", "snow", "sunny", "forecast", "umbrella"],
  ["food", "lunch", "vegetarian", "coffee", "dinner", "meal", "allergy", "peanuts"],
  ["work", "office", "meeting", "deadline", "project", "standup", "commute"],
];

export const FAKE_EMBEDDING_DIMS = CONCEPTS.length + 1;

export function conceptVector(text: string): number[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const v = CONCEPTS.map((c) => words.filter((w) => c.includes(w)).length);
  return [...v, 0.05];
}
