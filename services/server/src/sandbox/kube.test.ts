import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KUBE_API_TIMEOUT_MS, createKubeClient, statusMessage } from "./kube.js";

describe("statusMessage", () => {
  const denied =
    "namespaces \"kobe-admission-probe\" is forbidden: ValidatingAdmissionPolicy 'x' denied request: Kobe may only manage kobe-team-* namespaces, not kobe-admission-probe";

  it("reads the message of a Status sent as raw JSON text (client-node v2)", () => {
    expect(
      statusMessage(
        JSON.stringify({ kind: "Status", status: "Failure", message: denied, code: 403 }),
      ),
    ).toBe(denied);
  });

  it("reads a parsed Status, and falls back to plain text or undefined", () => {
    expect(statusMessage({ message: "x" })).toBe("x");
    expect(statusMessage("upstream connect error")).toBe("upstream connect error");
    expect(statusMessage(undefined)).toBeUndefined();
    expect(statusMessage("")).toBeUndefined();
  });
});

describe("createKubeClient timeouts (KOBE-732)", () => {
  // Calls made under a row or legal-hold lock (hibernation, volume deletes) must be bounded.
  it("gives up on an API server that accepts and never answers", async () => {
    expect(KUBE_API_TIMEOUT_MS).toBe(10_000);
    const sockets: Socket[] = [];
    const server = createServer((s) => {
      sockets.push(s);
      s.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const dir = mkdtempSync(join(tmpdir(), "kobe-kube-"));
    const file = join(dir, "config");
    writeFileSync(
      file,
      [
        "apiVersion: v1",
        "kind: Config",
        "clusters: [{name: c, cluster: {server: 'http://127.0.0.1:" +
          address.port +
          "', insecure-skip-tls-verify: true}}]",
        "users: [{name: u, user: {token: t}}]",
        "contexts: [{name: x, context: {cluster: c, user: u}}]",
        "current-context: x",
      ].join("\n"),
    );
    vi.stubEnv("KUBECONFIG", file);
    try {
      const kube = createKubeClient(300);
      const started = Date.now();
      await expect(
        kube.get({ apiVersion: "v1", kind: "Pod", name: "p", namespace: "n" }),
      ).rejects.toThrow(/timed out after 300 ms/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      vi.unstubAllEnvs();
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
