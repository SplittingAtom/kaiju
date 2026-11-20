#!/usr/bin/env node
// Audits the images' pinned Python and npm packages against OSV (osv.dev) and fails on a HIGH or
// CRITICAL advisory (KOBE-692). The npm workspace is audited by `pnpm audit`; this covers what
// pnpm cannot see: hashed requirement files and the sandbox's Pi lockfile.
//
//   scripts/osv-audit.mjs images/sandbox/requirements.txt images/sandbox/pi/package-lock.json ...
//
// Only package names and versions leave the runner. Severity: the GHSA rating (also through an
// alias, since PYSEC entries carry none), else the highest CVSS v3 base score, else UNKNOWN
// (reported, not failing).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const OSV = "https://api.osv.dev";
const FAILING = new Set(["HIGH", "CRITICAL"]);
const BATCH = 500;

/** `name==version` pins of a (hashed) requirements file; names normalised as PEP 503. */
export function parseRequirements(text) {
  const pins = [];
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)/.exec(line);
    if (m)
      pins.push({
        ecosystem: "PyPI",
        name: m[1].toLowerCase().replace(/[-_.]+/g, "-"),
        version: m[2],
      });
  }
  return pins;
}

/** Every installed package of an npm v2/v3 lockfile (nested copies too; links skipped). */
export function parseNpmLock(text) {
  const { packages = {} } = JSON.parse(text);
  const pins = [];
  for (const [path, info] of Object.entries(packages)) {
    if (!path || info.link || !info.version) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    pins.push({ ecosystem: "npm", name, version: info.version });
  }
  return pins;
}

const CVSS3 = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
};

function cvss3Score(vector) {
  const m = Object.fromEntries(
    vector
      .split("/")
      .slice(1)
      .map((p) => p.split(":")),
  );
  const changed = m.S === "C";
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR];
  const iss = 1 - (1 - CVSS3.CIA[m.C]) * (1 - CVSS3.CIA[m.I]) * (1 - CVSS3.CIA[m.A]);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploitability = 8.22 * CVSS3.AV[m.AV] * CVSS3.AC[m.AC] * pr * CVSS3.UI[m.UI];
  if ([impact, exploitability].some(Number.isNaN)) return undefined;
  if (impact <= 0) return 0;
  const raw = changed
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return Math.ceil(raw * 10) / 10;
}

/** OSV entry -> CRITICAL | HIGH | MODERATE | LOW | UNKNOWN. */
export function severityOf(vuln) {
  const rated = vuln.database_specific?.severity;
  if (typeof rated === "string" && rated) return rated.toUpperCase();
  const scores = (vuln.severity ?? [])
    .filter((s) => s.type === "CVSS_V3" && typeof s.score === "string")
    .map((s) => cvss3Score(s.score))
    .filter((s) => s !== undefined);
  if (scores.length === 0) return "UNKNOWN";
  const top = Math.max(...scores);
  if (top >= 9) return "CRITICAL";
  if (top >= 7) return "HIGH";
  if (top >= 4) return "MODERATE";
  return "LOW";
}

class HttpError extends Error {
  constructor(url, status) {
    super(`OSV ${url}: HTTP ${status}`);
    this.status = status;
  }
}

/** GET/POST with retries on network errors, 429 and 5xx; other statuses throw at once. */
async function getJson(fetchImpl, url, init, { retries = 3, retryDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, init);
      if (res.ok) return await res.json();
      const error = new HttpError(url, res.status);
      if (res.status !== 429 && res.status < 500) throw error;
      if (attempt >= retries) throw error;
    } catch (err) {
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      if (attempt >= retries) throw err;
    }
    await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
  }
}

/** Queries OSV for every pin; returns all findings and the failing (HIGH/CRITICAL) ones. A
 * lookup that still fails after retries throws (the run exits 2), so an advisory whose rating
 * could not be read never passes as UNKNOWN. Only a missing alias (404) is skipped. */
export async function audit(pins, { fetchImpl = fetch, retryDelayMs = 1000 } = {}) {
  const findings = [];
  const details = new Map();
  const detail = (id) => {
    if (!details.has(id)) {
      details.set(
        id,
        getJson(fetchImpl, `${OSV}/v1/vulns/${encodeURIComponent(id)}`, undefined, {
          retryDelayMs,
        }),
      );
    }
    return details.get(id);
  };
  const aliasDetail = (id) =>
    detail(id).catch((err) => {
      if (err instanceof HttpError && err.status === 404) return {};
      throw err;
    });
  for (let i = 0; i < pins.length; i += BATCH) {
    const batch = pins.slice(i, i + BATCH);
    const body = JSON.stringify({
      queries: batch.map((p) => ({
        package: { ecosystem: p.ecosystem, name: p.name },
        version: p.version,
      })),
    });
    const { results } = await getJson(
      fetchImpl,
      `${OSV}/v1/querybatch`,
      { method: "POST", headers: { "content-type": "application/json" }, body },
      { retryDelayMs },
    );
    for (const [j, result] of results.entries()) {
      for (const { id } of result.vulns ?? []) {
        const vuln = await detail(id);
        let severity = severityOf(vuln);
        for (const alias of vuln.aliases ?? []) {
          if (severity !== "UNKNOWN" || !alias.startsWith("GHSA-")) continue;
          severity = severityOf(await aliasDetail(alias));
        }
        findings.push({ ...batch[j], id, severity, summary: vuln.summary ?? "" });
      }
    }
  }
  return { findings, failing: findings.filter((f) => FAILING.has(f.severity)) };
}

function pinsOf(file) {
  const text = readFileSync(file, "utf8");
  const pins = file.endsWith(".json") ? parseNpmLock(text) : parseRequirements(text);
  return pins.map((p) => ({ ...p, source: file }));
}

async function main(files) {
  if (files.length === 0) {
    console.error("usage: osv-audit.mjs <requirements.txt | package-lock.json>...");
    process.exit(2);
  }
  const pins = files.flatMap(pinsOf);
  const { findings, failing } = await audit(pins);
  for (const f of findings) {
    console.log(`${f.severity.padEnd(8)} ${f.source}: ${f.name} ${f.version} ${f.id} ${f.summary}`);
  }
  console.log(
    `osv-audit: ${pins.length} pins, ${findings.length} advisories, ${failing.length} HIGH or CRITICAL`,
  );
  if (failing.length > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
