// Tests for osv-audit.mjs (KOBE-692): node --test scripts/osv-audit.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { audit, parseNpmLock, parseRequirements, severityOf } from "./osv-audit.mjs";

test("parseRequirements reads hashed name==version pins and skips the rest", () => {
  const text = [
    "# comment",
    "tornado==6.6.1 \\",
    "    --hash=sha256:aaa \\",
    "    --hash=sha256:bbb",
    "    # via jupyter-client",
    "Pillow==12.0.0 ; sys_platform == 'linux' \\",
    "orbit @ https://example.com/orbit-1.0.3-py3-none-any.whl \\",
    "-r other.txt",
  ].join("\n");
  assert.deepEqual(parseRequirements(text), [
    { ecosystem: "PyPI", name: "tornado", version: "6.6.1" },
    { ecosystem: "PyPI", name: "pillow", version: "12.0.0" },
  ]);
});

test("parseNpmLock reads every installed package of a v3 lockfile, nested ones included", () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "root" },
      "node_modules/minimatch": { version: "11.0.5" },
      "node_modules/a/node_modules/minimatch": { version: "10.2.6" },
      "node_modules/@scope/pkg": { version: "1.0.0" },
      "node_modules/linked": { link: true, resolved: "../x" },
    },
  };
  assert.deepEqual(parseNpmLock(JSON.stringify(lock)), [
    { ecosystem: "npm", name: "minimatch", version: "11.0.5" },
    { ecosystem: "npm", name: "minimatch", version: "10.2.6" },
    { ecosystem: "npm", name: "@scope/pkg", version: "1.0.0" },
  ]);
});

test("severityOf uses the GHSA rating, else the highest CVSS base score, else unknown", () => {
  assert.equal(severityOf({ database_specific: { severity: "HIGH" } }), "HIGH");
  assert.equal(severityOf({ database_specific: { severity: "moderate" } }), "MODERATE");
  assert.equal(
    severityOf({
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
    }),
    "CRITICAL",
  );
  assert.equal(
    severityOf({
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" }],
    }),
    "HIGH",
  );
  assert.equal(
    severityOf({
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N" }],
    }),
    "LOW",
  );
  assert.equal(severityOf({}), "UNKNOWN");
});

function fakeOsv(vulnsByPackage, details) {
  return async (url, init) => {
    if (url.endsWith("/v1/querybatch")) {
      const { queries } = JSON.parse(init.body);
      const results = queries.map((q) => {
        const ids = vulnsByPackage[`${q.package.name}@${q.version}`] ?? [];
        return ids.length ? { vulns: ids.map((id) => ({ id })) } : {};
      });
      return { ok: true, json: async () => ({ results }) };
    }
    const id = decodeURIComponent(url.split("/v1/vulns/")[1]);
    if (!details[id]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => ({ id, ...details[id] }) };
  };
}

test("audit fails on HIGH or CRITICAL, follows a PYSEC alias to its GHSA rating", async () => {
  const fetchImpl = fakeOsv(
    { "tornado@6.5.10": ["PYSEC-1"], "attrs@26.1.0": ["GHSA-low"] },
    {
      "PYSEC-1": { aliases: ["GHSA-high"], summary: "DoS" },
      "GHSA-high": { database_specific: { severity: "HIGH" } },
      "GHSA-low": { database_specific: { severity: "LOW" }, summary: "minor" },
    },
  );
  const pins = [
    { ecosystem: "PyPI", name: "tornado", version: "6.5.10", source: "req.txt" },
    { ecosystem: "PyPI", name: "attrs", version: "26.1.0", source: "req.txt" },
    { ecosystem: "PyPI", name: "clean", version: "1.0.0", source: "req.txt" },
  ];
  const report = await audit(pins, { fetchImpl });
  assert.equal(report.failing.length, 1);
  assert.deepEqual(
    { id: report.failing[0].id, severity: report.failing[0].severity },
    { id: "PYSEC-1", severity: "HIGH" },
  );
  assert.equal(report.findings.length, 2);
});

test("audit passes when nothing is HIGH or CRITICAL", async () => {
  const report = await audit([{ ecosystem: "npm", name: "x", version: "1.0.0", source: "l" }], {
    fetchImpl: fakeOsv({}, {}),
  });
  assert.deepEqual(report, { findings: [], failing: [] });
});
