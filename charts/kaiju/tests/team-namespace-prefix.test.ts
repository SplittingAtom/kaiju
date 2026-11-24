// KOBE-751: the team namespace prefix is configuration. Fresh installs get kaiju-team- and kaiju-*
// object names; an install created before the rename keeps kobe-team- and kobe-* (detected by
// `lookup` on upgrade). Exactly one prefix is in force: the admission policies, the server's
// sandbox config and the chart's own copies (the skill eval PriorityClass) all follow it.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSandboxSettings } from "../../../services/server/src/sandbox/config.js";
import {
  DEFAULT_TEAM_NAMESPACE_PREFIX,
  LABEL_TEAM_NAMESPACE,
  TEAM_NAMESPACE_PREFIXES,
  sandboxNames,
  type TeamNamespacePrefix,
} from "../../../services/server/src/sandbox/constants.js";
import {
  CHART_DIR,
  HELM,
  byKind,
  envOf,
  find,
  render,
  renderError,
  sandboxConfig,
} from "./sandbox.test-helpers.js";

// The detection rule without a cluster: a scratch chart with the real _sandbox.tpl and one template
// that calls `kaiju.resolveTeamNamespacePrefix` with made-up namespaces.
const scratch = mkdtempSync(join(tmpdir(), "kaiju-prefix-chart-"));
mkdirSync(join(scratch, "templates"));
writeFileSync(join(scratch, "Chart.yaml"), "apiVersion: v2\nname: prefix\nversion: 0.0.1\n");
cpSync(join(CHART_DIR, "templates", "_sandbox.tpl"), join(scratch, "templates", "_sandbox.tpl"));
writeFileSync(
  join(scratch, "templates", "out.yaml"),
  'prefix: {{ include "kaiju.resolveTeamNamespacePrefix" .Values.input | quote }}\n',
);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Input {
  readonly set?: string;
  readonly online?: boolean;
  readonly namespaces?: readonly { name: string; team?: boolean }[];
  readonly allowOffline?: boolean;
}

function resolve(input: Input): string {
  const values = {
    input: {
      set: input.set ?? "",
      online: input.online ?? true,
      allowOffline: input.allowOffline ?? false,
      namespaces: (input.namespaces ?? []).map((n) => ({
        metadata: {
          name: n.name,
          labels: n.team === false ? {} : { [LABEL_TEAM_NAMESPACE]: "true" },
        },
      })),
    },
  };
  const file = join(scratch, "values.json");
  writeFileSync(file, JSON.stringify(values));
  try {
    const out = execFileSync(HELM, ["template", "p", scratch, "-f", file], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return /prefix: "([^"]*)"/.exec(out)?.[1] ?? out;
  } catch (err) {
    return `ERROR ${String((err as { stderr?: string }).stderr ?? err)}`;
  }
}

describe("team namespace prefix detection (helm install/upgrade)", () => {
  it("defaults a fresh install (no team namespaces) to kaiju-team-", () => {
    expect(resolve({ namespaces: [{ name: "kube-system", team: false }] })).toBe("kaiju-team-");
  });

  it("keeps kobe-team- on an install created before the rename", () => {
    expect(resolve({ namespaces: [{ name: "kobe-team-a" }, { name: "kobe-team-b" }] })).toBe(
      "kobe-team-",
    );
    expect(resolve({ namespaces: [{ name: "kaiju-team-a" }] })).toBe("kaiju-team-");
  });

  it("goes by the team-namespace label only: an unlabelled kobe-team-* namespace is not a team's", () => {
    expect(resolve({ namespaces: [{ name: "kobe-team-x", team: false }] })).toBe("kaiju-team-");
  });

  it("refuses when team namespaces exist under both prefixes", () => {
    expect(resolve({ namespaces: [{ name: "kobe-team-a" }, { name: "kaiju-team-b" }] })).toMatch(
      /ERROR.*both prefixes kaiju-team- and kobe-team-.*exactly one/,
    );
  });

  it("refuses a value that does not match the existing namespaces, naming the value to set", () => {
    const out = resolve({ set: "kaiju-team-", namespaces: [{ name: "kobe-team-a" }] });
    expect(out).toMatch(/ERROR.*another prefix than sandbox\.teamNamespacePrefix "kaiju-team-"/);
    expect(out).toContain("kobe-team-a");
    expect(out).toContain('Set sandbox.teamNamespacePrefix to "kobe-team-"');
    expect(resolve({ set: "kobe-team-", namespaces: [{ name: "kobe-team-a" }] })).toBe(
      "kobe-team-",
    );
  });

  it("refuses labelled team namespaces under neither prefix", () => {
    const out = resolve({ namespaces: [{ name: "kobe-team-a" }, { name: "other-ns" }] });
    expect(out).toMatch(/ERROR.*other-ns.*remove the team-namespace label/);
  });

  it("cannot detect offline: the value is required unless the render is a throwaway one", () => {
    expect(resolve({ online: false })).toMatch(
      /ERROR.*Cannot detect the team namespace prefix in an offline render/,
    );
    expect(resolve({ online: false, allowOffline: true })).toBe("kaiju-team-");
    expect(resolve({ online: false, set: "kobe-team-" })).toBe("kobe-team-");
  });

  it("fails a GitOps-style render (offline, no throwaway switch) that does not set it", () => {
    const gitops = {
      "global.allowGeneratedSecretsOffline": "false",
      "auth.existingSecret": "a",
      "sandbox.sessionKeysSecret": "k",
      "sandbox.sessionVerifyKeysConfigMap": "v",
      "bifrost.keysSecret": "m",
      "mcpProxy.internalKeySecret": "i",
      "egressProxy.git.internalKeySecret": "g",
      "egressProxy.headerSecret": "h",
      "envelope.keySecret": "e",
    };
    expect(renderError(gitops)).toMatch(/Set sandbox\.teamNamespacePrefix: "kaiju-team-"/);
    const ms = render({ ...gitops, "sandbox.teamNamespacePrefix": "kobe-team-" });
    expect(sandboxConfig(ms).teamNamespacePrefix).toBe("kobe-team-");
  });

  it("accepts exactly the two prefixes the server knows", () => {
    expect(resolve({ set: "kube-" })).toMatch(/ERROR.*must be "kaiju-team-" or "kobe-team-"/);
    expect(renderError({ "sandbox.teamNamespacePrefix": "kube-" })).toMatch(
      /value must be one of '', 'kaiju-team-', 'kobe-team-'/,
    );
    expect([...TEAM_NAMESPACE_PREFIXES].sort()).toEqual(["kaiju-team-", "kobe-team-"]);
  });
});

describe.each(TEAM_NAMESPACE_PREFIXES)("an install with prefix %s", (prefix) => {
  const ms = render({ "sandbox.teamNamespacePrefix": prefix });
  const other = TEAM_NAMESPACE_PREFIXES.find((p) => p !== prefix) as TeamNamespacePrefix;
  const names = sandboxNames(prefix);

  it("hands the server the same prefix (validated by its own schema)", () => {
    expect(sandboxConfig(ms).teamNamespacePrefix).toBe(prefix);
    const raw = envOf(ms, "kaiju-server").find((e) => e.name === "KAIJU_SANDBOX_CONFIG")?.value;
    expect(loadSandboxSettings({ KAIJU_SANDBOX_CONFIG: raw })?.teamNamespacePrefix).toBe(prefix);
    const scheduler = envOf(ms, "kaiju-scheduler").find((e) => e.name === "KAIJU_SANDBOX_CONFIG");
    expect(JSON.parse(scheduler?.value ?? "{}").teamNamespacePrefix).toBe(prefix);
  });

  const policy = (suffix: string) =>
    byKind(ms, "ValidatingAdmissionPolicy").find((p) => p.metadata.name.endsWith(suffix));

  it("pins the server's write scope (policy 1) to this prefix only", () => {
    const scope = JSON.stringify(policy("-server-scope")?.spec);
    expect(scope).toContain(`variables.target.startsWith('${prefix}')`);
    expect(scope).toContain(`may only manage ${prefix}* namespaces`);
    expect(scope).not.toContain(other);
  });

  it("holds the restricting policies (2-4) in team namespaces under both prefixes", () => {
    for (const suffix of ["-sandbox-pods", "-sandbox-specs", "-sandbox-netpol"]) {
      const conditions = policy(suffix)?.spec.matchConditions as {
        name: string;
        expression: string;
      }[];
      expect(conditions, suffix).toEqual([
        {
          name: "team-namespace",
          expression: TEAM_NAMESPACE_PREFIXES.map(
            (p) => `request.namespace.startsWith('${p}')`,
          ).join(" || "),
        },
      ]);
    }
  });

  it("names the skill eval PriorityClass like the server's naming generation", () => {
    const classes = byKind(ms, "PriorityClass").map((p) => p.metadata.name);
    expect(classes).toEqual([names.evalPriorityClass]);
    expect(find(ms, "PriorityClass", names.evalPriorityClass)).toBeDefined();
  });

  it("leaves RBAC and the proxies' NetworkPolicies unchanged (labels, no namespace names)", () => {
    const rbac = JSON.stringify([...byKind(ms, "ClusterRole"), ...byKind(ms, "Role")]);
    expect(rbac).not.toMatch(/-team-/);
    const policies = JSON.stringify(byKind(ms, "NetworkPolicy"));
    expect(policies).not.toMatch(/kaiju-team-|kobe-team-/);
    expect(policies).toContain(LABEL_TEAM_NAMESPACE);
  });
});

describe("naming generations (server)", () => {
  it("ties every object name to the prefix: kaiju-* on fresh installs, kobe-* kept", () => {
    const fresh = sandboxNames(DEFAULT_TEAM_NAMESPACE_PREFIX);
    const kept = sandboxNames("kobe-team-");
    expect(DEFAULT_TEAM_NAMESPACE_PREFIX).toBe("kaiju-team-");
    for (const [key, value] of Object.entries(fresh)) {
      if (key === "prefix") continue;
      expect(value).toMatch(/^kaiju-/);
      expect((kept as unknown as Record<string, string>)[key]).toBe(
        value.replace(/^kaiju-/, "kobe-"),
      );
    }
    // The names existing installs already have (nothing is recreated on upgrade).
    expect(kept).toMatchObject({
      serviceAccount: "kobe-sandbox",
      template: "kobe-sandbox",
      warmPool: "kobe-sandbox",
      networkPolicy: "kobe-sandbox-isolation",
      evalNetworkPolicy: "kobe-orbit-eval-isolation",
      skillScanNetworkPolicy: "kobe-skill-scan",
      resourceQuota: "kobe-team-quota",
      memberResourceQuota: "kobe-team-member-quota",
      evalResourceQuota: "kobe-skill-eval-quota",
      evalTemplate: "kobe-skill-eval",
      evalWarmPool: "kobe-skill-eval",
      evalPriorityClass: "kobe-skill-eval",
      limitRange: "kobe-sandbox-defaults",
      serverRoleBinding: "kobe-server",
      managedBy: "kobe-server",
      fieldManager: "kobe-server",
      bootstrapVolume: "kobe-bootstrap",
    });
  });
});
