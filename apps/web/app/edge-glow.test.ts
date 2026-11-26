import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRESETS } from "../lib/theme/presets";

/**
 * KOBE-840 ac-3: the chat window's edge glow. `--kaiju-glow-waiting` (gold) and
 * `--kaiju-glow-error` (red), each with a border, are fixed tokens set in light and both dark
 * blocks of app/theme.css; the glow is drawn inside the thread root on a layer that takes no
 * pointer (so the floating column's border and hover halo stay theirs), the gold breathes only
 * without prefers-reduced-motion, and forced colours get a system outline.
 */
const WEB = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) =>
  readFileSync(join(WEB, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const THEME = read("app/theme.css");
const CHAT = read("app/chat-global.css");

function block(source: string, prelude: string): string {
  const at = source.indexOf(`${prelude} {`);
  if (at < 0) throw new Error(`no block ${prelude}`);
  let depth = 1;
  const start = at + prelude.length + 2;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i);
  }
  throw new Error(`unclosed block ${prelude}`);
}

const TOKENS = ["--kaiju-glow-waiting", "--kaiju-glow-error"];

describe("the edge glow's tokens", () => {
  const blocks = {
    light: block(THEME, ":root"),
    chosenDark: block(THEME, ':root[data-theme="dark"]'),
    osDark: block(
      block(THEME, "@media (prefers-color-scheme: dark)"),
      ':root:not([data-theme="light"])',
    ),
  };
  for (const [scheme, body] of Object.entries(blocks)) {
    it(`are set in ${scheme}`, () => {
      for (const token of TOKENS) {
        expect(body).toMatch(new RegExp(`${token}:\\s*rgb\\(`, "u"));
        expect(body).toMatch(new RegExp(`${token}-border:\\s*#`, "u"));
      }
    });
  }

  it("differ between light and dark", () => {
    const value = (body: string, token: string) =>
      new RegExp(`${token}-border:\\s*([^;]+);`, "u").exec(body)?.[1];
    for (const token of TOKENS) {
      expect(value(blocks.light, token)).not.toBe(value(blocks.chosenDark, token));
    }
  });

  it("no preset overrides them (fixed, like the gold glow)", () => {
    const presets = JSON.stringify(PRESETS);
    for (const token of TOKENS) expect(presets).not.toContain(token);
  });
});

const LAYER = "[data-kaiju-chat] [data-kaiju-edge-glow]::after";
const WAITING = '[data-kaiju-chat] [data-kaiju-edge-glow="waiting"]::after';

/** The rule for `selector` inside the `media` block that holds one. */
function inMedia(media: string, selector: string): string {
  for (let at = CHAT.indexOf(media); at >= 0; at = CHAT.indexOf(media, at + 1)) {
    const body = block(CHAT.slice(at), media);
    if (body.includes(`${selector} {`)) return block(body, selector);
  }
  throw new Error(`no ${selector} in ${media}`);
}

describe("the edge glow's rules", () => {
  const layer = block(CHAT, LAYER);
  const waiting = block(CHAT, WAITING);
  const error = block(CHAT, '[data-kaiju-chat] [data-kaiju-edge-glow="error"]::after');

  it("draw inside the conversation on a layer that takes no pointer", () => {
    expect(layer).toContain("position: absolute");
    expect(layer).toContain("inset: 0");
    expect(layer).toContain("pointer-events: none");
    expect(waiting).toContain("inset 0 0 0 2px var(--kaiju-glow-waiting-border)");
    expect(error).toContain("inset 0 0 0 2px var(--kaiju-glow-error-border)");
  });

  it("gold breathes, red stays still, and reduced motion stops the gold", () => {
    expect(waiting).toContain("animation: kaiju-edge-glow");
    expect(error).not.toContain("animation");
    expect(inMedia("@media (prefers-reduced-motion: reduce)", WAITING)).toContain(
      "animation: none",
    );
  });

  it("forced colours get a system outline instead of the halo", () => {
    const rule = inMedia("@media (forced-colors: active)", LAYER);
    expect(rule).toContain("box-shadow: none");
    expect(rule).toContain("Highlight");
  });
});
