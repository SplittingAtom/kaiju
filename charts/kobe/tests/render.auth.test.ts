import { describe, expect, it } from "vitest";
import { type Manifest, render, renderError, find } from "./render.test-helpers.js";

describe("auth (KOBE-12)", () => {
  const env = (ms: Manifest[], name: string) =>
    find(ms, "Deployment", name)?.spec.template.spec.containers[0].env as unknown[];

  it("gives the server the public URL derived from the ingress", () => {
    expect(env(render(), "kobe-server")).toContainEqual({
      name: "KOBE_PUBLIC_URL",
      value: "https://kobe.example.com",
    });
    expect(env(render({ "ingress.tls.enabled": "false" }), "kobe-server")).toContainEqual({
      name: "KOBE_PUBLIC_URL",
      value: "http://kobe.example.com",
    });
    expect(env(render({ publicUrl: "https://chat.example.org" }), "kobe-server")).toContainEqual({
      name: "KOBE_PUBLIC_URL",
      value: "https://chat.example.org",
    });
  });

  it("generates and keeps auth and setup secrets, mounted only by the server", () => {
    const ms = render();
    const secret = find(ms, "Secret", "kobe-auth") as unknown as {
      metadata: { annotations: Record<string, string> };
      stringData: { secret: string; "setup-token": string };
    };
    expect(secret.metadata.annotations["helm.sh/resource-policy"]).toBe("keep");
    expect(secret.stringData.secret).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(secret.stringData["setup-token"]).toMatch(/^[A-Za-z0-9]{32}$/);
    const server = env(ms, "kobe-server");
    expect(server).toContainEqual({
      name: "KOBE_AUTH_SECRET",
      valueFrom: { secretKeyRef: { name: "kobe-auth", key: "secret" } },
    });
    expect(server).toContainEqual({
      name: "KOBE_SETUP_TOKEN",
      valueFrom: { secretKeyRef: { name: "kobe-auth", key: "setup-token" } },
    });
    for (const name of [
      "kobe-scheduler",
      "kobe-web",
      "kobe-mcp-proxy",
      "kobe-egress-proxy",
      "kobe-bifrost",
    ]) {
      expect(JSON.stringify(find(ms, "Deployment", name)), name).not.toContain("kobe-auth");
    }
  });

  it("trusts the k3s pod network's proxies for client IPs by default", () => {
    expect(env(render(), "kobe-server")).toContainEqual({
      name: "KOBE_TRUSTED_PROXIES",
      value: "10.42.0.0/16",
    });
    expect(
      env(
        render({
          "auth.trustedProxies[0]": "10.0.0.0/8",
          "auth.trustedProxies[1]": "192.168.0.0/16",
        }),
        "kobe-server",
      ),
    ).toContainEqual({ name: "KOBE_TRUSTED_PROXIES", value: "10.0.0.0/8,192.168.0.0/16" });
  });

  it("uses a pre-created auth secret when given (GitOps-safe)", () => {
    const ms = render({
      "auth.existingSecret": "my-auth",
      "sandbox.sessionKeysSecret": "my-keys",
      "sandbox.sessionVerifyKeysConfigMap": "my-verify-keys",
      "bifrost.keysSecret": "my-model-keys",
      "mcpProxy.internalKeySecret": "my-mcp-key",
      "egressProxy.git.internalKeySecret": "my-git-key",
      "egressProxy.headerSecret": "my-egress-headers",
      "envelope.keySecret": "my-envelope",
      "global.allowGeneratedSecretsOffline": "false",
    });
    expect(find(ms, "Secret", "kobe-auth")).toBeUndefined();
    expect(env(ms, "kobe-server")).toContainEqual({
      name: "KOBE_AUTH_SECRET",
      valueFrom: { secretKeyRef: { name: "my-auth", key: "secret" } },
    });
  });

  it("refuses to generate secrets in an offline render (each render would rotate them)", () => {
    expect(
      renderError({
        "global.allowGeneratedSecretsOffline": "false",
        "sandbox.sessionKeysSecret": "my-keys",
        "sandbox.sessionVerifyKeysConfigMap": "my-verify-keys",
        "bifrost.keysSecret": "my-model-keys",
        "mcpProxy.internalKeySecret": "my-mcp-key",
        "egressProxy.git.internalKeySecret": "my-git-key",
        "egressProxy.headerSecret": "my-egress-headers",
        "envelope.keySecret": "my-envelope",
      }),
    ).toMatch(/auth\.existingSecret/);
    expect(
      renderError({
        "global.allowGeneratedSecretsOffline": "false",
        "auth.existingSecret": "my-auth",
        "sandbox.sessionKeysSecret": "my-keys",
        "sandbox.sessionVerifyKeysConfigMap": "my-verify-keys",
        "bifrost.keysSecret": "my-model-keys",
        "mcpProxy.internalKeySecret": "my-mcp-key",
        "egressProxy.git.internalKeySecret": "my-git-key",
        "egressProxy.headerSecret": "my-egress-headers",
        "envelope.keySecret": "my-envelope",
        "postgres.mode": "cnpg",
      }),
    ).toMatch(/postgres\.cnpg\.existingAppSecret/);
    expect(
      renderError({
        "global.allowGeneratedSecretsOffline": "false",
        "auth.existingSecret": "my-auth",
        "bifrost.keysSecret": "my-model-keys",
        "mcpProxy.internalKeySecret": "my-mcp-key",
        "egressProxy.git.internalKeySecret": "my-git-key",
        "egressProxy.headerSecret": "my-egress-headers",
        "envelope.keySecret": "my-envelope",
      }),
    ).toMatch(/sandbox\.sessionKeysSecret/);
    expect(
      renderError({
        "global.allowGeneratedSecretsOffline": "false",
        "auth.existingSecret": "my-auth",
        "sandbox.sessionKeysSecret": "my-keys",
        "sandbox.sessionVerifyKeysConfigMap": "my-verify-keys",
        "mcpProxy.internalKeySecret": "my-mcp-key",
        "egressProxy.git.internalKeySecret": "my-git-key",
        "egressProxy.headerSecret": "my-egress-headers",
        "envelope.keySecret": "my-envelope",
      }),
    ).toMatch(/bifrost\.keysSecret/);
    expect(
      renderError({
        "global.allowGeneratedSecretsOffline": "false",
        "auth.existingSecret": "my-auth",
        "sandbox.sessionKeysSecret": "my-keys",
        "sandbox.sessionVerifyKeysConfigMap": "my-verify-keys",
        "bifrost.keysSecret": "my-model-keys",
        "egressProxy.git.internalKeySecret": "my-git-key",
        "egressProxy.headerSecret": "my-egress-headers",
        "envelope.keySecret": "my-envelope",
      }),
    ).toMatch(/mcpProxy\.internalKeySecret/);
    expect(
      renderError({
        "global.allowGeneratedSecretsOffline": "false",
        "auth.existingSecret": "my-auth",
        "sandbox.sessionKeysSecret": "my-keys",
        "sandbox.sessionVerifyKeysConfigMap": "my-verify-keys",
        "bifrost.keysSecret": "my-model-keys",
        "mcpProxy.internalKeySecret": "my-mcp-key",
        "egressProxy.git.internalKeySecret": "my-git-key",
        "envelope.keySecret": "my-envelope",
      }),
    ).toMatch(/egressProxy\.headerSecret/);
    expect(
      renderError({
        "global.allowGeneratedSecretsOffline": "false",
        "auth.existingSecret": "my-auth",
        "sandbox.sessionKeysSecret": "my-keys",
        "sandbox.sessionVerifyKeysConfigMap": "my-verify-keys",
        "bifrost.keysSecret": "my-model-keys",
        "mcpProxy.internalKeySecret": "my-mcp-key",
        "egressProxy.git.internalKeySecret": "my-git-key",
        "egressProxy.headerSecret": "my-egress-headers",
      }),
    ).toMatch(/envelope\.keySecret/);
    expect(
      renderError({
        "global.allowGeneratedSecretsOffline": "false",
        "auth.existingSecret": "my-auth",
        "sandbox.sessionKeysSecret": "my-keys",
        "sandbox.sessionVerifyKeysConfigMap": "my-verify-keys",
        "bifrost.keysSecret": "my-model-keys",
        "mcpProxy.internalKeySecret": "my-mcp-key",
        "egressProxy.headerSecret": "my-egress-headers",
        "envelope.keySecret": "my-envelope",
      }),
    ).toMatch(/egressProxy\.git\.internalKeySecret/);
  });
});

describe("ClamAV", () => {
  const on = render({ "clamav.enabled": "true" });
  const serverEnv = (ms: Manifest[]) =>
    find(ms, "Deployment", "kobe-server")?.spec.template.spec.containers[0].env as {
      name: string;
      value?: string;
    }[];

  it("is off by default and optional", () => {
    expect(find(render(), "Deployment", "kobe-clamav")).toBeUndefined();
    expect(find(on, "Deployment", "kobe-clamav")).toBeDefined();
  });

  it("pins the image by tag and digest, and drops the digest only when set empty (KOBE-691)", () => {
    const image = (ms: Manifest[]) =>
      find(ms, "Deployment", "kobe-clamav")?.spec.template.spec.containers[0].image as string;
    expect(image(on)).toMatch(/^docker\.io\/clamav\/clamav:1\.4@sha256:[0-9a-f]{64}$/);
    expect(image(render({ "clamav.enabled": "true", "clamav.image.digest": "" }))).toBe(
      "docker.io/clamav/clamav:1.4",
    );
  });

  it("tells the server where clamd is only when enabled (scanning then fails closed)", () => {
    expect(serverEnv(render()).map((e) => e.name)).not.toContain("KOBE_CLAMAV_HOST");
    expect(serverEnv(on)).toContainEqual({ name: "KOBE_CLAMAV_HOST", value: "kobe-clamav" });
    expect(serverEnv(on)).toContainEqual({ name: "KOBE_CLAMAV_PORT", value: "3310" });
  });

  it("runs as the image's non-root user with the unprivileged entrypoint", () => {
    const pod = find(on, "Deployment", "kobe-clamav")?.spec.template.spec;
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 100,
      runAsGroup: 101,
      seccompProfile: { type: "RuntimeDefault" },
    });
    const c = pod.containers[0];
    expect(c.command).toEqual(["/init-unprivileged"]);
    expect(c.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("configures clamd to reject what it cannot fully scan, up to the upload limit", () => {
    const conf = find(on, "ConfigMap", "kobe-clamav")?.data["clamd.conf"] as string;
    expect(conf).toMatch(/^TCPSocket 3310$/m);
    expect(conf).toMatch(/^StreamMaxLength 524288000$/m);
    expect(conf).toMatch(/^MaxFileSize 524288000$/m);
    expect(conf).toMatch(/^AlertExceedsMax yes$/m);
    const raised = render({ "clamav.enabled": "true", "server.uploads.maxFileBytes": "900000000" });
    expect(find(raised, "ConfigMap", "kobe-clamav")?.data["clamd.conf"]).toMatch(
      /^StreamMaxLength 900000000$/m,
    );
  });
});

describe("SMTP (KOBE-13)", () => {
  const env = (ms: Manifest[], name: string) =>
    find(ms, "Deployment", name)?.spec.template.spec.containers[0].env as unknown[];

  it("is required: a host and a sender (spec D7)", () => {
    expect(renderError({}, ["smtp.host"])).toMatch(/smtp\/host|smtp\.host/);
    expect(renderError({}, ["smtp.from"])).toMatch(/smtp\/from|smtp\.from/);
    expect(renderError({ "smtp.security": "ssl" })).toMatch(/security/);
    expect(renderError({ "smtp.bogus": "1" })).toMatch(/additional properties/i);
  });

  it("gives only the API server the SMTP settings, with STARTTLS on 587 by default", () => {
    const ms = render();
    const server = env(ms, "kobe-server");
    expect(server).toContainEqual({ name: "KOBE_SMTP_HOST", value: "smtp.example.com" });
    expect(server).toContainEqual({ name: "KOBE_SMTP_PORT", value: "587" });
    expect(server).toContainEqual({ name: "KOBE_SMTP_SECURITY", value: "starttls" });
    expect(server).toContainEqual({ name: "KOBE_SMTP_FROM", value: "Kobe <kobe@example.com>" });
    expect(JSON.stringify(server)).not.toContain("KOBE_SMTP_PASSWORD");
    for (const name of ["kobe-scheduler", "kobe-web", "kobe-mcp-proxy", "kobe-egress-proxy"]) {
      expect(JSON.stringify(find(ms, "Deployment", name)), name).not.toContain("KOBE_SMTP");
    }
  });

  it("reads SMTP credentials from a Secret, never from values", () => {
    const server = env(
      render({ "smtp.existingSecret": "kobe-smtp", "smtp.port": "465", "smtp.security": "tls" }),
      "kobe-server",
    );
    expect(server).toContainEqual({
      name: "KOBE_SMTP_USERNAME",
      valueFrom: { secretKeyRef: { name: "kobe-smtp", key: "username" } },
    });
    expect(server).toContainEqual({
      name: "KOBE_SMTP_PASSWORD",
      valueFrom: { secretKeyRef: { name: "kobe-smtp", key: "password" } },
    });
    expect(server).toContainEqual({ name: "KOBE_SMTP_PORT", value: "465" });
  });

  it("refuses credentials over unencrypted SMTP", () => {
    expect(renderError({ "smtp.security": "none", "smtp.existingSecret": "kobe-smtp" })).toMatch(
      /existingSecret/,
    );
    expect(env(render({ "smtp.security": "none" }), "kobe-server")).toContainEqual({
      name: "KOBE_SMTP_SECURITY",
      value: "none",
    });
  });
});
