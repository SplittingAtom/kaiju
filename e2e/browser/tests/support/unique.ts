/**
 * Words that make a spec's memory statement unique per run (KOBE-388). Letters only, never
 * digits: a long digit run such as `Date.now()` reads as a phone number to the save checks'
 * personal-data warning on Workspace and Site memories, and a statement that differs from an
 * earlier run's only in a stamp is a near-duplicate of it (trigram similarity 0.6). Three random
 * words keep two runs' statements well below that, so leftovers of a failed run never block the
 * next one. Keep a statement with these words within 60 characters: rows and their buttons are
 * named by the statement, shortened with "…" past 60.
 */
const LETTERS = "bcdfghjkmnpqrstvwxz";

function word(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => LETTERS[b % LETTERS.length]).join("");
}

/** Three random 8-letter words, e.g. `kqzmtvhr wpxnbcdf ghjkmnpq`. */
export function uniqueWords(): string {
  return [word(8), word(8), word(8)].join(" ");
}
