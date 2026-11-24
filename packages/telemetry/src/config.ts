import { z } from "zod";

/**
 * Tracing configuration (KOBE-10, spec D31), validated at startup like every service config. No
 * endpoint means tracing is off and nothing is registered (zero overhead). Content capture is an
 * site-level opt-in; by default spans carry metadata only.
 */
const configSchema = z.object({
  /** OTLP/HTTP collector base URL, e.g. http://otel-collector:4318 (`/v1/traces` is appended). */
  KAIJU_OTEL_ENDPOINT: z
    .url({ protocol: /^https?$/, error: "KAIJU_OTEL_ENDPOINT must be an http(s) URL" })
    .optional(),
  /** Exporter headers as `name=value,name=value` (credentials for hosted backends). */
  KAIJU_OTEL_HEADERS: z.string().optional(),
  /** Opt in to message, prompt, tool input/output and query-string capture on spans. */
  KAIJU_OTEL_CAPTURE_CONTENT: z
    .enum(["true", "false"], { error: "KAIJU_OTEL_CAPTURE_CONTENT must be true or false" })
    .default("false"),
});

export interface TelemetryConfig {
  readonly enabled: boolean;
  readonly endpoint?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly captureContent: boolean;
  readonly serviceName: string;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) {
      // Never echo the value: it may be a credential.
      throw new Error("Invalid configuration: KAIJU_OTEL_HEADERS must be name=value pairs");
    }
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function loadTelemetryConfig(
  env: Readonly<Record<string, string | undefined>>,
  service: string,
): TelemetryConfig {
  const parsed = configSchema.safeParse({
    KAIJU_OTEL_ENDPOINT: env.KAIJU_OTEL_ENDPOINT?.trim() || undefined,
    KAIJU_OTEL_HEADERS: env.KAIJU_OTEL_HEADERS,
    KAIJU_OTEL_CAPTURE_CONTENT: env.KAIJU_OTEL_CAPTURE_CONTENT?.trim() || undefined,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const d = parsed.data;
  const headers = parseHeaders(d.KAIJU_OTEL_HEADERS);
  const endpoint = d.KAIJU_OTEL_ENDPOINT?.replace(/\/+$/, "");
  return {
    enabled: endpoint !== undefined,
    ...(endpoint === undefined ? {} : { endpoint }),
    headers,
    captureContent: d.KAIJU_OTEL_CAPTURE_CONTENT === "true",
    serviceName: `kaiju-${service}`,
  };
}
