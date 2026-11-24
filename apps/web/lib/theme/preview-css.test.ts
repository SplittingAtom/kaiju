import { PRESET_IDS, type ThemeSettings } from "@kaiju/protocol";
import { describe, expect, it } from "vitest";
import { BRANDING_CSS_ALLOWED, brandingCss } from "./branding-css";
import { PRESETS, RADIUS_SCALES } from "./presets";
import { PREVIEW_FIXED_TOKENS, PREVIEW_IDS, previewCss } from "./preview-css";
import { declarations, THEME_DARK, THEME_LIGHT } from "./theme-css-source.test-helpers";

/** KOBE-501: the Appearance preview's CSS, the real brandingCss over a scoped copy of theme.css. */
const CUSTOM: ThemeSettings = {
  preset: "custom",
  accent: "#0f766e",
  corners: "round",
  font: "serif",
};

/** The top-level rules (the OS-dark @media block repeats the chosen-dark one, so it is skipped). */
function rules(css: string): [string, [string, string][]][] {
  const out: [string, [string, string][]][] = [];
  const top = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, "");
  for (const m of top.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    for (const selector of (m[1] ?? "").split(",")) {
      out.push([selector.trim(), declarations(m[2] ?? "")]);
    }
  }
  return out;
}

/** What a preview root resolves: rules on `#id` (1,0,0), then `#id[data-theme=…]` (1,1,0). */
function resolve(css: string, scheme: "light" | "dark"): Map<string, string> {
  const id = PREVIEW_IDS[scheme];
  const all = rules(css);
  const plain = all.filter(([s]) => s === `#${id}`);
  const themed = all.filter(([s]) => s === `#${id}[data-theme="${scheme}"]`);
  return new Map([...plain, ...themed].flatMap(([, d]) => d));
}

describe("previewCss", () => {
  it("holds brandingCss for both preview roots, after the scoped defaults", () => {
    for (const theme of [{ preset: "plum" } as const, CUSTOM]) {
      const css = previewCss(theme);
      const light = brandingCss(theme, "#preview-light");
      const dark = brandingCss(theme, "#preview-dark");
      expect(light).not.toBe("");
      expect(css.endsWith(`${light}${dark}`)).toBe(true);
    }
  });

  it("gives each root theme.css's own values for the default preset", () => {
    const css = previewCss({ preset: "default" });
    for (const [scheme, source] of [
      ["light", THEME_LIGHT],
      ["dark", THEME_DARK],
    ] as const) {
      const got = resolve(css, scheme);
      for (const token of [...Object.keys(PRESETS.default[scheme]), ...PREVIEW_FIXED_TOKENS]) {
        expect(got.get(token), `${scheme} ${token}`).toBe(source.get(token));
      }
      expect(got.get("color-scheme")).toBe(scheme);
      expect(got.get("--kaiju-radius-md")).toBe(THEME_LIGHT.get("--kaiju-radius-md"));
    }
  });

  it("redeclares the accent aliases so they follow the preview's brand tokens", () => {
    for (const scheme of ["light", "dark"] as const) {
      const got = resolve(previewCss({ preset: "default" }), scheme);
      expect(got.get("--admin-accent")).toBe("var(--kaiju-brand-link)");
      expect(got.get("--kaiju-status-accent")).toBe("var(--kaiju-brand-primary)");
      expect(got.get("--kaiju-status-accent-fg")).toBe("var(--kaiju-brand-primary-fg)");
    }
  });

  it.each(PRESET_IDS)("shows preset %s in its light and its dark values", (id) => {
    const css = previewCss({ preset: id });
    expect(resolve(css, "light").get("--kaiju-console-bg")).toBe(
      PRESETS[id].light["--kaiju-console-bg"],
    );
    expect(resolve(css, "dark").get("--kaiju-console-bg")).toBe(
      PRESETS[id].dark["--kaiju-console-bg"],
    );
    expect(resolve(css, "dark").get("--kaiju-brand-primary")).toBe(
      PRESETS[id].dark["--kaiju-brand-primary"],
    );
  });

  it("applies a custom accent's corners and typeface to the dark root too", () => {
    const dark = resolve(previewCss(CUSTOM), "dark");
    expect(dark.get("--kaiju-radius-md")).toBe(RADIUS_SCALES.round["--kaiju-radius-md"]);
    expect(dark.get("--kaiju-font-sans")).toContain("serif");
    expect(dark.get("--kaiju-console-bg")).toBe(THEME_DARK.get("--kaiju-console-bg"));
  });

  /** KOBE-555 (ac-2): the Appearance preview shows Catalyst's faces in both roots. */
  it("shows the catalyst faces in the light and dark previews; the default keeps system stacks", () => {
    for (const scheme of ["light", "dark"] as const) {
      const catalyst = resolve(previewCss({ preset: "catalyst" }), scheme);
      expect(catalyst.get("--kaiju-font-sans")).toMatch(/^var\(--kaiju-face-outfit/);
      expect(catalyst.get("--kaiju-font-mono")).toMatch(/^var\(--kaiju-face-jetbrains-mono/);
      const plain = resolve(previewCss({ preset: "default" }), scheme);
      expect(plain.get("--kaiju-font-mono")).toBe(THEME_LIGHT.get("--kaiju-font-mono"));
    }
  });

  it("gives the logo swatches plain light and dark values, whatever the theme", () => {
    const rulesOf = rules(previewCss({ preset: "plum" }));
    const swatch = (scheme: string) =>
      new Map(
        rulesOf.filter(([s]) => s === `[data-kaiju-swatch="${scheme}"]`).flatMap(([, d]) => d),
      );
    expect(swatch("light").get("--kaiju-console-bg")).toBe(THEME_LIGHT.get("--kaiju-console-bg"));
    expect(swatch("dark").get("--kaiju-console-bg")).toBe(THEME_DARK.get("--kaiju-console-bg"));
  });

  it("is token declarations only, in the branding allow-list", () => {
    for (const theme of [{ preset: "default" } as const, { preset: "ember" } as const, CUSTOM]) {
      expect(previewCss(theme)).toMatch(BRANDING_CSS_ALLOWED);
    }
  });
});
