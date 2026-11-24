import { legacyEnv, type LegacyEnvWarn } from "@kaiju/protocol/legacy-env";
import { logger } from "./logger.js";
import { verifyKeysFromEnv, type SessionVerifyKeys } from "@kaiju/session-token";
import { z } from "zod";
import { validateCidrs, validateInternalTargets } from "./address-policy.js";

/**
 * MCP proxy configuration (spec D27), validated at startup: invalid env fails fast. The chart
 * renders it from `mcpProxy.*` values. The proxy has no database: the server decides every call
 * (internal listener) and the proxy holds only its own session-token key and the internal key.
 */
const MIN_KEY_LENGTH = 32;

const int = (name: string, min: number, max: number, fallback: number) =>
  z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .min(min, `${name} must be between ${min} and ${max}`)
    .max(max, `${name} must be between ${min} and ${max}`)
    .default(fallback);

const list = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );

const key = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(MIN_KEY_LENGTH, `${name} must be at least ${MIN_KEY_LENGTH} characters`);

const configSchema = z.object({
  PORT: int("PORT", 1, 65535, 8080),
  /** The server's internal listener (policy re-check), e.g. http://kaiju-server:8082. */
  KAIJU_MCP_SERVER_URL: z.url({
    protocol: /^https?$/,
    error: "KAIJU_MCP_SERVER_URL must be an http(s) URL",
  }),
  KAIJU_MCP_INTERNAL_KEY: key("KAIJU_MCP_INTERNAL_KEY"),
  /**
   * The server's routes (probe, app calls) listen here, not on PORT (KOBE-693): the
   * NetworkPolicy admits only server pods to this port, while sandboxes reach PORT.
   */
  KAIJU_MCP_INTERNAL_PORT: int("KAIJU_MCP_INTERNAL_PORT", 1, 65535, 8081),
  /**
   * The key the server presents to those routes (KOBE-693), separate from KAIJU_MCP_INTERNAL_KEY,
   * which the proxy presents to the server. Empty or unset (an operator's Secret without the
   * second key): KAIJU_MCP_INTERNAL_KEY serves both ways, with a startup warning.
   */
  KAIJU_MCP_ROUTES_KEY: z
    .string()
    .default("")
    .pipe(
      z.union([
        z.literal(""),
        z
          .string()
          .min(
            MIN_KEY_LENGTH,
            `KAIJU_MCP_ROUTES_KEY must be at least ${MIN_KEY_LENGTH} characters`,
          ),
      ]),
    ),
  /** Plain-http connector URLs (development and the e2e suite only; credentials would leak). */
  KAIJU_MCP_ALLOW_INSECURE_HTTP: z
    .enum(["true", "false"], { error: "KAIJU_MCP_ALLOW_INSECURE_HTTP must be true or false" })
    .default("false"),
  /** Upstream ports connectors may use. */
  KAIJU_MCP_ALLOWED_PORTS: list,
  /** Internal targets explicitly allowed (on-premises MCP servers), as CIDRs. */
  KAIJU_MCP_ALLOWED_INTERNAL_CIDRS: list,
  /** More ranges to refuse (cluster pod/Service CIDRs when not private). */
  KAIJU_MCP_DENIED_CIDRS: list,
  KAIJU_MCP_MAX_REQUEST_BYTES: int(
    "KAIJU_MCP_MAX_REQUEST_BYTES",
    1_024,
    16 * 1024 * 1024,
    1024 * 1024,
  ),
  KAIJU_MCP_MAX_RESPONSE_BYTES: int(
    "KAIJU_MCP_MAX_RESPONSE_BYTES",
    1_024,
    64 * 1024 * 1024,
    4 * 1024 * 1024,
  ),
  /** Whole upstream call (connect, initialize, call); under Pi's 60 s MCP request timeout. */
  KAIJU_MCP_UPSTREAM_TIMEOUT_MS: int("KAIJU_MCP_UPSTREAM_TIMEOUT_MS", 1_000, 600_000, 55_000),
  KAIJU_MCP_SERVER_TIMEOUT_MS: int("KAIJU_MCP_SERVER_TIMEOUT_MS", 100, 60_000, 10_000),
  /**
   * The grant call (KOBE-778, P2-29): it may include an OAuth refresh, which can wait for another
   * server replica's refresh lease (up to 10 s) and then refresh itself (5 s deadline). A call's
   * own deadline (`KAIJU_MCP_UPSTREAM_TIMEOUT_MS`, which covers the whole call) still bounds it.
   */
  KAIJU_MCP_GRANT_TIMEOUT_MS: int("KAIJU_MCP_GRANT_TIMEOUT_MS", 1_000, 120_000, 25_000),
  /** Concurrent calls per sandbox and per replica. */
  KAIJU_MCP_CALLS_PER_SANDBOX: int("KAIJU_MCP_CALLS_PER_SANDBOX", 1, 1_000, 8),
  KAIJU_MCP_MAX_CONCURRENT_CALLS: int("KAIJU_MCP_MAX_CONCURRENT_CALLS", 1, 100_000, 256),
  /** Requests per sandbox: a burst, then this many per second. */
  KAIJU_MCP_REQUEST_BURST: int("KAIJU_MCP_REQUEST_BURST", 1, 10_000, 60),
  KAIJU_MCP_REQUESTS_PER_SECOND: int("KAIJU_MCP_REQUESTS_PER_SECOND", 1, 10_000, 10),
});

export interface Limits {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly upstreamTimeoutMs: number;
  readonly serverTimeoutMs: number;
  /** The grant call, which may refresh an OAuth token: longer than `serverTimeoutMs`. */
  readonly grantTimeoutMs: number;
  readonly callsPerSandbox: number;
  readonly maxConcurrentCalls: number;
  readonly requestBurst: number;
  readonly requestsPerSecond: number;
}

export interface UpstreamPolicy {
  readonly allowInsecureHttp: boolean;
  readonly allowedPorts: readonly number[];
  readonly allowedInternalCidrs: readonly string[];
  readonly deniedCidrs: readonly string[];
}

export interface Config {
  readonly port: number;
  /**
   * Public key(s) verifying sandboxes' `kobe.mcp-proxy` session tokens
   * (KAIJU_SESSION_VERIFY_KEY_MCP_PROXY; never a private key, never another audience's).
   */
  readonly sessionVerifyKeys: SessionVerifyKeys;
  readonly serverUrl: string;
  /** What the proxy presents to the server's internal listener. */
  readonly internalKey: string;
  /** The port of the server-facing routes (probe, app calls), KOBE-693. */
  readonly internalPort: number;
  /** What the server presents to those routes (KOBE-693). */
  readonly routesKey: string;
  /** True when no separate routes key is configured and `internalKey` serves both ways. */
  readonly routesKeyShared: boolean;
  readonly upstream: UpstreamPolicy;
  readonly limits: Limits;
}

export const DEFAULT_LIMITS: Limits = {
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  upstreamTimeoutMs: 55_000,
  serverTimeoutMs: 10_000,
  grantTimeoutMs: 25_000,
  callsPerSandbox: 8,
  maxConcurrentCalls: 256,
  requestBurst: 60,
  requestsPerSecond: 10,
};

function ports(values: readonly string[]): number[] {
  const parsed = (values.length === 0 ? ["443"] : values).map(Number);
  if (parsed.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error("Invalid configuration: KAIJU_MCP_ALLOWED_PORTS must be ports (1-65535)");
  }
  return parsed;
}

function cidrs(name: string, values: readonly string[]): readonly string[] {
  try {
    validateCidrs(values);
  } catch {
    throw new Error(`Invalid configuration: ${name} must be a comma-separated list of CIDRs`);
  }
  return values;
}

/**
 * KOBE-694: install-wide internal targets may not start in or cover an always-refused range
 * (loopback, link-local, metadata, unspecified, IPv4-embedding); a private LAN range is fine.
 */
function internalCidrs(name: string, values: readonly string[]): readonly string[] {
  cidrs(name, values);
  try {
    validateInternalTargets(values);
  } catch (err) {
    throw new Error(`Invalid configuration: ${name}: ${(err as Error).message}`, { cause: err });
  }
  return values;
}

/** The one startup warning about old KOBE_* names (KOBE-748): names only, never values. */
const warnLegacyEnv: LegacyEnvWarn = (message, fields) => logger.warn(fields, message);

export function loadConfig(
  rawEnv: Readonly<Record<string, string | undefined>>,
  warn: LegacyEnvWarn = warnLegacyEnv,
): Config {
  // KAIJU_* names; the old KOBE_* names stand in for one release (KOBE-748).
  const env = legacyEnv(rawEnv, warn);
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    // Messages only (never values), so keys can't leak into logs.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const d = parsed.data;
  if (d.KAIJU_MCP_GRANT_TIMEOUT_MS < d.KAIJU_MCP_SERVER_TIMEOUT_MS) {
    throw new Error(
      "Invalid configuration: KAIJU_MCP_GRANT_TIMEOUT_MS must be at least KAIJU_MCP_SERVER_TIMEOUT_MS (a grant call may refresh an OAuth token)",
    );
  }
  if (d.KAIJU_MCP_INTERNAL_PORT === d.PORT) {
    throw new Error("Invalid configuration: KAIJU_MCP_INTERNAL_PORT must differ from PORT");
  }
  return {
    port: d.PORT,
    sessionVerifyKeys: verifyKeysFromEnv(env, "kobe.mcp-proxy"),
    serverUrl: d.KAIJU_MCP_SERVER_URL.replace(/\/+$/, ""),
    internalKey: d.KAIJU_MCP_INTERNAL_KEY,
    internalPort: d.KAIJU_MCP_INTERNAL_PORT,
    routesKey: d.KAIJU_MCP_ROUTES_KEY === "" ? d.KAIJU_MCP_INTERNAL_KEY : d.KAIJU_MCP_ROUTES_KEY,
    routesKeyShared: d.KAIJU_MCP_ROUTES_KEY === "",
    upstream: {
      allowInsecureHttp: d.KAIJU_MCP_ALLOW_INSECURE_HTTP === "true",
      allowedPorts: ports(d.KAIJU_MCP_ALLOWED_PORTS),
      allowedInternalCidrs: internalCidrs(
        "KAIJU_MCP_ALLOWED_INTERNAL_CIDRS",
        d.KAIJU_MCP_ALLOWED_INTERNAL_CIDRS,
      ),
      deniedCidrs: cidrs("KAIJU_MCP_DENIED_CIDRS", d.KAIJU_MCP_DENIED_CIDRS),
    },
    limits: {
      maxRequestBytes: d.KAIJU_MCP_MAX_REQUEST_BYTES,
      maxResponseBytes: d.KAIJU_MCP_MAX_RESPONSE_BYTES,
      upstreamTimeoutMs: d.KAIJU_MCP_UPSTREAM_TIMEOUT_MS,
      serverTimeoutMs: d.KAIJU_MCP_SERVER_TIMEOUT_MS,
      grantTimeoutMs: d.KAIJU_MCP_GRANT_TIMEOUT_MS,
      callsPerSandbox: d.KAIJU_MCP_CALLS_PER_SANDBOX,
      maxConcurrentCalls: d.KAIJU_MCP_MAX_CONCURRENT_CALLS,
      requestBurst: d.KAIJU_MCP_REQUEST_BURST,
      requestsPerSecond: d.KAIJU_MCP_REQUESTS_PER_SECOND,
    },
  };
}
