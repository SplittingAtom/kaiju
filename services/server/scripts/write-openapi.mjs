#!/usr/bin/env node
// Writes the server's OpenAPI 3.1 document (src/openapi/document.ts) as JSON (KOBE-815). The file
// is generated, not committed: CI builds it on every push and keeps it as the `openapi` artifact.
// Reads the built package, so build first:
//   pnpm --filter @kaiju/server build && pnpm --filter @kaiju/server openapi [out]
// Default out: services/server/openapi.json (gitignored).
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../dist/openapi/document.js";

const out = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL("../openapi.json", import.meta.url));
const doc = openApiDocument();
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`openapi: wrote ${Object.keys(doc.paths).length} paths to ${out}`);
