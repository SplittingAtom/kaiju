import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// The bundled CloudNativePG Cluster (KOBE-737): pgvector created on bootstrap, and the backup and
// plugins sections passed through verbatim.

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";
const BASE: Record<string, string> = {
  "ingress.host": "kobe.example.com",
  "postgres.mode": "cnpg",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kobe",
  "s3.existingSecret": "kobe-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kaiju <kobe@example.com>",
  "global.allowGeneratedSecretsOffline": "true",
};

type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };

/** Renders with BASE plus a values file (YAML text), returning the Cluster. */
function cluster(valuesYaml = ""): Manifest | undefined {
  const dir = mkdtempSync(join(tmpdir(), "kobe-cnpg-test-"));
  try {
    const file = join(dir, "values.yaml");
    writeFileSync(file, valuesYaml);
    const args = Object.entries(BASE).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
    const out = execFileSync(
      HELM,
      ["template", "kobe", CHART_DIR, "-n", "kobe", ...args, "-f", file],
      { encoding: "utf8", stdio: "pipe" },
    );
    return parseAllDocuments(out)
      .map((d) => d.toJSON() as Manifest | null)
      .find((m): m is Manifest => m?.kind === "Cluster");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bundled CloudNativePG Cluster (KOBE-737)", () => {
  it("creates pgvector on bootstrap, only when the image has it", () => {
    const sql = cluster()?.spec.bootstrap.initdb.postInitApplicationSQL as string[];
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
    expect(sql[0]).toContain("FROM pg_available_extensions WHERE name = 'vector'");
    expect(cluster()?.spec.bootstrap.initdb).toMatchObject({
      database: "kobe",
      owner: "kobe_owner",
    });
  });

  it("has no backup or plugins section unless set", () => {
    const spec = cluster()?.spec;
    expect(spec?.backup).toBeUndefined();
    expect(spec?.plugins).toBeUndefined();
  });

  it("passes postgres.cnpg.backup and plugins verbatim", () => {
    const spec = cluster(`
postgres:
  cnpg:
    backup:
      retentionPolicy: 30d
      barmanObjectStore:
        destinationPath: s3://kobe-pg-backups/
        endpointURL: https://s3.example.com
        s3Credentials:
          accessKeyId: { name: pg-backup-s3, key: access-key-id }
          secretAccessKey: { name: pg-backup-s3, key: secret-access-key }
        wal:
          compression: gzip
    plugins:
      - name: barman-cloud.cloudnative-pg.io
        isWALArchiver: true
        parameters:
          barmanObjectName: kobe-pg-store
`)?.spec;
    expect(spec?.backup).toEqual({
      retentionPolicy: "30d",
      barmanObjectStore: {
        destinationPath: "s3://kobe-pg-backups/",
        endpointURL: "https://s3.example.com",
        s3Credentials: {
          accessKeyId: { name: "pg-backup-s3", key: "access-key-id" },
          secretAccessKey: { name: "pg-backup-s3", key: "secret-access-key" },
        },
        wal: { compression: "gzip" },
      },
    });
    expect(spec?.plugins).toEqual([
      {
        name: "barman-cloud.cloudnative-pg.io",
        isWALArchiver: true,
        parameters: { barmanObjectName: "kobe-pg-store" },
      },
    ]);
  });

  it("refuses a backup that is not an object", () => {
    expect(() => cluster("postgres:\n  cnpg:\n    backup: daily\n")).toThrow(/backup/);
    expect(() => cluster("postgres:\n  cnpg:\n    plugins: {name: x}\n")).toThrow(/plugins/);
  });
});
