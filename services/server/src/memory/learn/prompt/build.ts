import {
  SERVER_CALL_LIMITS,
  SERVER_CALL_RESPONSE_FORMATS,
  type ServerCallRequest,
} from "@kobe/protocol";
import type { ExtractorExistingItem, ExtractorPromptInput } from "./input.js";

/**
 * Builds the `memory_learn` call's four messages (KOBE-394, SM15), in this order:
 *
 * 1. system: the version's static guidance and reply format (byte-stable: the cacheable prefix);
 * 2. user: the thread's project and the existing items, Policy first, fenced;
 * 3. user: the transcript, each entry under a fenced header naming its id and speaker;
 * 4. user: the version's static closing instructions.
 *
 * Fences carry a random per-pass nonce, so text inside the data cannot close a fence or forge an
 * entry header. The prompt is model-neutral; the caller adds `response_format` where the provider
 * supports it (`SERVER_CALL_RESPONSE_FORMATS.memory_learn`), which is counted in the body check.
 */

export interface ExtractorPromptVersion {
  readonly version: string;
  readonly system: string;
  readonly instructions: string;
}

/** Most existing items listed (Policy first, then in the caller's order); the rest are left out. */
export const EXTRACTOR_MAX_EXISTING_ITEMS = 100;
/** Room in the body for everything but the messages and the response format (model, caps). */
export const EXTRACTOR_BODY_HEADROOM_BYTES = 4096;
/** Shortest nonce accepted: random per pass (at least 64 bits as hex). */
export const EXTRACTOR_NONCE_MIN_CHARS = 16;
const NONCE = /^[A-Za-z0-9]+$/;

export type ExtractorMessagesResult =
  | {
      readonly ok: true;
      readonly prompt_version: string;
      readonly messages: ServerCallRequest["messages"];
    }
  | {
      readonly ok: false;
      /** `too_large`: over the purpose's message or body cap (KOBE-392 trims the transcript). */
      readonly reason: "too_large" | "nonce_in_content";
    };

const itemLine = (item: ExtractorExistingItem): string =>
  JSON.stringify({
    id: item.id,
    scope: item.scope,
    kind: item.kind,
    policy: item.policy,
    statement: item.statement,
  });

function contextMessage(input: ExtractorPromptInput, nonce: string): string {
  const ordered = [
    ...input.existing.filter((i) => i.policy),
    ...input.existing.filter((i) => !i.policy),
  ].slice(0, EXTRACTOR_MAX_EXISTING_ITEMS);
  const project =
    input.project === null
      ? "Thread project: none (this thread is in no project; project_specific is always false)."
      : `Thread project: ${JSON.stringify(input.project.name)}`;
  return [
    project,
    "",
    `Existing memories the person can see, one JSON object per line, between <<<memories ${nonce}>>> and <<<end ${nonce}>>>:`,
    `<<<memories ${nonce}>>>`,
    ...(ordered.length === 0 ? ["(none)"] : ordered.map(itemLine)),
    `<<<end ${nonce}>>>`,
  ].join("\n");
}

function transcriptMessage(input: ExtractorPromptInput, nonce: string): string {
  return [
    `The conversation, oldest entry first. Each entry starts with a line <<<entry ${nonce} id=... speaker=...>>> and runs to the next such line or to <<<end ${nonce}>>>.`,
    "Speakers: person (the person teaching Kobe), assistant (Kobe's replies), tool (tool output), summary (a model-written summary of earlier turns).",
    ...input.transcript.flatMap((e) => [
      `<<<entry ${nonce} id=${e.entry_id} speaker=${e.speaker}>>>`,
      e.text,
    ]),
    `<<<end ${nonce}>>>`,
  ].join("\n");
}

/** The call's messages for `input` under prompt `version`, or why they cannot be sent. */
export function buildExtractorMessages(
  version: ExtractorPromptVersion,
  input: ExtractorPromptInput,
  nonce: string,
): ExtractorMessagesResult {
  if (nonce.length < EXTRACTOR_NONCE_MIN_CHARS || !NONCE.test(nonce))
    throw new Error("extractor nonce must be at least 16 letters or digits");
  const data = [
    input.project?.name ?? "",
    ...input.existing.map((i) => i.statement),
    ...input.transcript.flatMap((e) => [e.entry_id, e.text]),
  ];
  if (data.some((t) => t.includes(nonce))) return { ok: false, reason: "nonce_in_content" };
  const contents = [
    version.system,
    contextMessage(input, nonce),
    transcriptMessage(input, nonce),
    version.instructions,
  ];
  const limits = SERVER_CALL_LIMITS.memory_learn;
  const bodyBytes =
    Buffer.byteLength(JSON.stringify(contents.map((content) => ({ role: "user", content })))) +
    Buffer.byteLength(JSON.stringify(SERVER_CALL_RESPONSE_FORMATS.memory_learn)) +
    EXTRACTOR_BODY_HEADROOM_BYTES;
  if (
    contents.some((c) => c.length > limits.max_message_chars) ||
    bodyBytes > limits.max_body_bytes
  )
    return { ok: false, reason: "too_large" };
  const [system, context, transcript, instructions] = contents as [string, string, string, string];
  return {
    ok: true,
    prompt_version: version.version,
    messages: [
      { role: "system", content: system },
      { role: "user", content: context },
      { role: "user", content: transcript },
      { role: "user", content: instructions },
    ],
  };
}
