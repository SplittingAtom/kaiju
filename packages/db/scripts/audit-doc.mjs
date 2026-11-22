#!/usr/bin/env node
// Regenerates the event taxonomy table in docs/audit-log.md from the per-area rows in
// src/audit/events/<area>.doc.ts (KOBE-815). Reads the built package, so build first:
//   pnpm --filter @kobe/db build && pnpm --filter @kobe/db audit:doc           # rewrite the page
//   pnpm --filter @kobe/db audit:doc --check                                  # exit 1 if stale
// Only the block between the audit-events:start/end markers changes; the prose around it is
// hand-written.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withAuditEventTable } from "../dist/audit/event-docs.js";

const PAGE = fileURLToPath(new URL("../../../docs/audit-log.md", import.meta.url));
const check = process.argv.includes("--check");

const current = readFileSync(PAGE, "utf8");
const next = withAuditEventTable(current);
if (next === current) {
  console.log("audit:doc: docs/audit-log.md is up to date");
} else if (check) {
  console.error(
    "audit:doc: docs/audit-log.md is stale: run `pnpm --filter @kobe/db build && pnpm --filter @kobe/db audit:doc`",
  );
  process.exit(1);
} else {
  writeFileSync(PAGE, next);
  console.log("audit:doc: docs/audit-log.md regenerated");
}
