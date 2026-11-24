import type { ThinkingLevel } from "@kaiju/protocol";
import { contentAttributes, idAttributes, type Context, type RequestSpan } from "@kaiju/telemetry";
import type { CallContext } from "../seams.js";
import type { UsageReading } from "../usage/meter.js";
import type { GatewayOptions } from "./options.js";

/**
 * What one admitted request accumulates on its way through the gateway, read once it ends to
 * meter it (span attributes, the gate's release, the byte budget, the usage record).
 */
export interface RequestState {
  readonly started: number;
  readonly limitKey: string;
  bytesIn: number;
  promptBody: Buffer | undefined;
  usage: UsageReading | undefined;
  ttfbMs: number | undefined;
  releaseGate: ((written: boolean) => void) | undefined;
  bytesOut: number;
  bytesHeld: number;
  status: number;
  errorType: string | undefined;
  aborted: boolean;
  call: CallContext | undefined;
  traceContext: Context | undefined;
  thinkingLevel: ThinkingLevel | undefined;
}

export function newRequestState(started: number, limitKey: string): RequestState {
  return {
    started,
    limitKey,
    bytesIn: 0,
    promptBody: undefined,
    usage: undefined,
    ttfbMs: undefined,
    releaseGate: undefined,
    bytesOut: 0,
    bytesHeld: 0,
    status: 0,
    errorType: undefined,
    aborted: false,
    call: undefined,
    traceContext: undefined,
    thinkingLevel: undefined,
  };
}

/** A call that answered with an error: no tokens. */
export const NO_TOKENS: UsageReading = {
  source: "reported",
  counts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A call that reached the upstream but never answered: its input and its whole allowance. */
export const unanswered = (requestBytes: number, allowance: number): UsageReading => ({
  source: "estimated",
  counts: {
    input: Math.ceil(requestBytes / 4),
    output: allowance,
    cacheRead: 0,
    cacheWrite: 0,
  },
});

/**
 * The end of an admitted request (after its concurrency slot is released): the span's metadata,
 * the gate's reservation, the bytes held, and the usage record.
 */
export function finishRequest(
  options: Pick<GatewayOptions, "bytes" | "sink">,
  span: RequestSpan,
  state: RequestState,
): void {
  const { call, usage } = state;
  if (call) {
    // Metadata only; the prompt joins only when content capture is on.
    span.setAttributes({
      ...idAttributes({
        teamId: call.teamId,
        userId: call.userId,
        sandboxId: call.sandboxId,
        runId: call.runId,
      }),
      "kaiju.call_id": call.callId,
      "kaiju.usage_kind": call.purpose ?? (call.eval ? "eval" : "run"),
      "kaiju.route": call.route,
      ...(state.thinkingLevel === undefined ? {} : { "kaiju.thinking_level": state.thinkingLevel }),
      ...(call.model === undefined ? {} : { "gen_ai.request.model": call.model }),
      ...(usage === undefined
        ? {}
        : {
            "gen_ai.usage.input_tokens": usage.counts.input,
            "gen_ai.usage.output_tokens": usage.counts.output,
          }),
      "http.response.status_code": state.status,
      "http.request.body.size": state.bytesIn,
      "http.response.body.size": state.bytesOut,
      "kaiju.aborted": state.aborted,
      ...(state.promptBody
        ? contentAttributes({ "gen_ai.prompt": state.promptBody.toString("utf8") })
        : {}),
    });
  }
  // The reservation lasts until the call's ledger row lands (usageRecordOf: forwarded calls
  // that named a model), so the gate never sees spend that is neither reserved nor recorded.
  state.releaseGate?.(usage !== undefined && call?.model !== undefined);
  options.bytes.give(state.limitKey, state.bytesHeld);
  if (call) {
    options.sink.record({
      ...call,
      status: state.status,
      startedAt: new Date(state.started),
      durationMs: Date.now() - state.started,
      ttfbMs: state.ttfbMs,
      usage,
      bytesIn: state.bytesIn,
      bytesOut: state.bytesOut,
      errorType: state.errorType,
      aborted: state.aborted,
    });
  }
}
