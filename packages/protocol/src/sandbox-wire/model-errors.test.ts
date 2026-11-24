import { describe, expect, it } from "vitest";
import {
  KAIJU_MODEL_ERROR_PREFIX,
  MODEL_RUN_ERROR_CODES,
  kaijuModelErrorMessage,
  parseKaijuModelError,
} from "./pi-events.js";

describe("kobe-models error messages (sandbox → server, in Pi's errorMessage)", () => {
  it("round-trips a code through the message the extension writes", () => {
    const message = kaijuModelErrorMessage("model_not_enabled", "That model is not enabled.");
    expect(message.startsWith(KAIJU_MODEL_ERROR_PREFIX)).toBe(true);
    expect(parseKaijuModelError(message)).toBe("model_not_enabled");
  });

  it("accepts every documented code and nothing else", () => {
    for (const code of MODEL_RUN_ERROR_CODES) {
      expect(parseKaijuModelError(`${KAIJU_MODEL_ERROR_PREFIX}${code}: detail`)).toBe(code);
    }
    expect(parseKaijuModelError(`${KAIJU_MODEL_ERROR_PREFIX}made_up: x`)).toBeUndefined();
    expect(parseKaijuModelError(`${KAIJU_MODEL_ERROR_PREFIX}MODEL_ERROR: x`)).toBeUndefined();
  });

  it("ignores anything that is not a kobe-models message (untrusted Pi output)", () => {
    expect(parseKaijuModelError(undefined)).toBeUndefined();
    expect(parseKaijuModelError(42)).toBeUndefined();
    expect(parseKaijuModelError('403: {"error":{"code":"model_not_enabled"}}')).toBeUndefined();
    expect(parseKaijuModelError(` ${KAIJU_MODEL_ERROR_PREFIX}model_error: x`)).toBeUndefined();
    expect(parseKaijuModelError(`x${KAIJU_MODEL_ERROR_PREFIX}model_error`)).toBeUndefined();
  });

  it("keeps the detail out of the parsed result (the server never shows sandbox text)", () => {
    expect(parseKaijuModelError(`${KAIJU_MODEL_ERROR_PREFIX}model_error: <script>`)).toBe(
      "model_error",
    );
  });
});
