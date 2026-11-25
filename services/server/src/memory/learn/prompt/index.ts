import {
  buildExtractorMessages,
  type ExtractorMessagesResult,
  type ExtractorPromptVersion,
} from "./build.js";
import type { ExtractorPromptInput } from "./input.js";
import { INSTRUCTIONS, PROMPT_VERSION, SYSTEM } from "./v3/prompt.js";

/**
 * The extractor prompt in use (KOBE-394). A pass records `prompt_version` with its candidates so a
 * reviewer and the extractor eval (U52) can tell versions apart. Older versions stay in their
 * folders with their fixtures.
 */
export const CURRENT_EXTRACTOR_PROMPT: ExtractorPromptVersion = {
  version: PROMPT_VERSION,
  system: SYSTEM,
  instructions: INSTRUCTIONS,
};

/** The current prompt's messages for one pass; `nonce` is fresh per pass (randomBytes hex). */
export const extractorMessages = (
  input: ExtractorPromptInput,
  nonce: string,
): ExtractorMessagesResult => buildExtractorMessages(CURRENT_EXTRACTOR_PROMPT, input, nonce);

export {
  EXTRACTOR_MAX_EXISTING_ITEMS,
  buildExtractorMessages,
  type ExtractorMessagesResult,
  type ExtractorPromptVersion,
} from "./build.js";
export * from "./input.js";
