#!/usr/bin/env node
/**
 * KOBE-801: copies what the PDF viewer loads at run time from `pdfjs-dist` into
 * `public/pdfjs/<version>/` (gitignored), so it is served from the app's own origin and ships in
 * the image with `public/`: the worker (legacy build, as `lib/files/pdfjs.ts` imports), the
 * predefined CMaps, the JavaScript image decoders used without WebAssembly, and their licences.
 * Not copied: the WebAssembly files (the CSP has no 'wasm-unsafe-eval'), the scripting sandbox
 * and QuickJS (PDF JavaScript never runs), the standard fonts (system fonts stand in) and the ICC
 * profiles (need WebAssembly). Runs before `next build` and `next dev`; older versions are removed.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("pdfjs-dist/package.json"));
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "pdfjs");
const target = join(publicDir, version);

/** [source relative to the package, destination relative to the version directory]. */
const FILES = [
  ["legacy/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["LICENSE", "LICENSE"],
  ["wasm/openjpeg_nowasm_fallback.js", "wasm/openjpeg_nowasm_fallback.js"],
  ["wasm/jbig2_nowasm_fallback.js", "wasm/jbig2_nowasm_fallback.js"],
  ["wasm/LICENSE_OPENJPEG", "wasm/LICENSE_OPENJPEG"],
  ["wasm/LICENSE_PDFJS_OPENJPEG", "wasm/LICENSE_PDFJS_OPENJPEG"],
  ["wasm/LICENSE_JBIG2", "wasm/LICENSE_JBIG2"],
  ["wasm/LICENSE_PDFJS_JBIG2", "wasm/LICENSE_PDFJS_JBIG2"],
];

if (existsSync(publicDir)) {
  for (const entry of readdirSync(publicDir)) {
    if (entry !== version) rmSync(join(publicDir, entry), { recursive: true, force: true });
  }
}
mkdirSync(join(target, "wasm"), { recursive: true });
for (const [from, to] of FILES) cpSync(join(pkgDir, from), join(target, to));
cpSync(join(pkgDir, "cmaps"), join(target, "cmaps"), { recursive: true });
console.log(`pdf.js ${version} assets copied to public/pdfjs/${version}/`);
