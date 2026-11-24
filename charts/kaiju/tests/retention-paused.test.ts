import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for retention.paused (KOBE-243): chart value -> KAIJU_RETENTION_PAUSED; and the
// table sweeps (KOBE-741): retention.sweeps.* -> KAIJU_RETENTION_*_DAYS/_MONTHS (0 = off).

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";
const BASE: Record<string, string> = {
  "ingress.host": "kaiju.example.com",
  "postgres.external.existingSecret": "kaiju-db",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kaiju",
  "s3.existingSecret": "kaiju-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kaiju <kaiju@example.com>",
  "global.allowGeneratedSecretsOffline": "true",
};

type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };

function envOf(
  deployment: string,
  name: string,
  values: Record<string, string> = {},
): string | undefined {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  const out = execFileSync(HELM, ["template", "kaiju", CHART_DIR, "-n", "kaiju", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const ms = parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
  const dep = ms.find((m) => m.kind === "Deployment" && m.metadata.name === deployment);
  const env = (dep?.spec.template.spec.containers[0].env ?? []) as {
    name: string;
    value?: string;
  }[];
  return env.find((e) => e.name === name)?.value;
}

const pausedOf = (deployment: string, values: Record<string, string> = {}) =>
  envOf(deployment, "KAIJU_RETENTION_PAUSED", values);

describe("retention.paused", () => {
  it.each(["kaiju-server", "kaiju-scheduler"])("is false by default on %s", (name) => {
    expect(pausedOf(name)).toBe("false");
  });

  it.each(["kaiju-server", "kaiju-scheduler"])("sets KAIJU_RETENTION_PAUSED on %s", (name) => {
    expect(pausedOf(name, { "retention.paused": "true" })).toBe("true");
  });
});

describe("retention.sweeps (KOBE-741)", () => {
  const SWEEPS = {
    KAIJU_RETENTION_EVENTS_DAYS: "30",
    KAIJU_RETENTION_READ_NOTIFICATIONS_DAYS: "180",
    KAIJU_RETENTION_RUN_USAGE_MONTHS: "13",
    KAIJU_RETENTION_EVAL_HISTORY_MONTHS: "12",
  };

  it("renders the owner's periods by default on the server", () => {
    for (const [name, value] of Object.entries(SWEEPS)) {
      expect(envOf("kaiju-server", name)).toBe(value);
    }
  });

  it("renders a changed period, and 0 for a sweep turned off", () => {
    const values = {
      "retention.sweeps.events.days": "60",
      "retention.sweeps.readNotifications.enabled": "false",
      "retention.sweeps.runUsage.months": "24",
      "retention.sweeps.evalHistory.enabled": "false",
    };
    expect(envOf("kaiju-server", "KAIJU_RETENTION_EVENTS_DAYS", values)).toBe("60");
    expect(envOf("kaiju-server", "KAIJU_RETENTION_READ_NOTIFICATIONS_DAYS", values)).toBe("0");
    expect(envOf("kaiju-server", "KAIJU_RETENTION_RUN_USAGE_MONTHS", values)).toBe("24");
    expect(envOf("kaiju-server", "KAIJU_RETENTION_EVAL_HISTORY_MONTHS", values)).toBe("0");
  });

  it("refuses a period outside the schema's range", () => {
    expect(() =>
      envOf("kaiju-server", "KAIJU_RETENTION_EVENTS_DAYS", { "retention.sweeps.events.days": "1" }),
    ).toThrow();
    expect(() =>
      envOf("kaiju-server", "KAIJU_RETENTION_RUN_USAGE_MONTHS", {
        "retention.sweeps.runUsage.months": "3",
      }),
    ).toThrow();
  });
});
