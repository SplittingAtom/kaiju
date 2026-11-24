import { describe, expect, it } from "vitest";
import { UPLOAD_DEFAULT_MAX_FILE_BYTES, UPLOAD_DEFAULT_MAX_MESSAGE_BYTES } from "@kaiju/protocol";
import { DEFAULT_UPLOAD_SETTINGS, loadUploadSettings } from "./settings.js";

describe("upload settings", () => {
  it("defaults to the contract constants", () => {
    const s = loadUploadSettings({});
    expect(s).toEqual(DEFAULT_UPLOAD_SETTINGS);
    expect(s.maxFileBytes).toBe(UPLOAD_DEFAULT_MAX_FILE_BYTES);
    expect(s.maxMessageBytes).toBe(UPLOAD_DEFAULT_MAX_MESSAGE_BYTES);
  });

  it("reads overrides and fails fast naming the variable", () => {
    expect(loadUploadSettings({ KAIJU_UPLOAD_MAX_FILE_BYTES: "2048" }).maxFileBytes).toBe(2048);
    expect(() => loadUploadSettings({ KAIJU_UPLOAD_MAX_FILE_BYTES: "0" })).toThrow(
      /KAIJU_UPLOAD_MAX_FILE_BYTES/,
    );
    expect(() => loadUploadSettings({ KAIJU_UPLOAD_ORPHAN_HOURS: "x" })).toThrow(
      /KAIJU_UPLOAD_ORPHAN_HOURS/,
    );
  });

  it("turns scanning on only when the chart gives a clamd host", () => {
    expect(loadUploadSettings({}).clamav).toBeUndefined();
    expect(loadUploadSettings({ KAIJU_CLAMAV_HOST: "kaiju-clamav" }).clamav).toEqual({
      host: "kaiju-clamav",
      port: 3310,
      timeoutMs: 60_000,
    });
    expect(
      loadUploadSettings({ KAIJU_CLAMAV_HOST: "h", KAIJU_CLAMAV_PORT: "4000" }).clamav?.port,
    ).toBe(4000);
    expect(() => loadUploadSettings({ KAIJU_CLAMAV_HOST: "h", KAIJU_CLAMAV_PORT: "0" })).toThrow(
      /KAIJU_CLAMAV_PORT/,
    );
  });
});
