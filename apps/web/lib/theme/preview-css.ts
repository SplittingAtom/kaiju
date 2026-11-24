import type { ThemeSettings } from "@kaiju/protocol";
import { BRANDING_CSS_ALLOWED, brandingCss } from "./branding-css";
import {
  FONT_STACK_VALUES,
  PRESETS,
  RADIUS_SCALES,
  RADIUS_TOKENS,
  SYSTEM_MONO_STACK,
} from "./presets";

/**
 * The Appearance preview's CSS (KOBE-501, theming plan §6): two preview roots, one light and one
 * dark whatever the admin's own theme, each styled by the real `brandingCss(theme, "#<root>")`.
 *
 * brandingCss only overrides what a theme changes, so each root first gets a scoped copy of
 * theme.css's defaults (the default preset's values, the status colours the preview shows, the
 * logo's light/dark switch) and the aliases that read the brand tokens: a custom property that
 * reads another one is resolved where it is declared, so `--admin-accent: var(--kaiju-brand-link)`
 * on :root would ignore the preview's own link colour. The dark root is `data-theme="dark"`, so
 * brandingCss's chosen-dark block applies to it and its OS-dark block never touches the light one.
 * Ordering and specificity: `#root` (defaults, then the theme's light block) under
 * `#root[data-theme="dark"]` (defaults, then the theme's dark block).
 */

export const PREVIEW_IDS = { light: "preview-light", dark: "preview-dark" } as const;

/**
 * Elements with `data-kaiju-swatch="light|dark"` (the logo's light and dark backgrounds on the
 * page) get that scheme's default values too, without the theme: plain light and dark.
 */
export const SWATCH_ATTRIBUTE = "data-kaiju-swatch";

/** Fixed (never themed) tokens the preview reads, as theme.css sets them (preview-css.test.ts). */
const FIXED = {
  light: {
    "--kaiju-status-running": "#166534",
    "--kaiju-status-running-bg": "#dcfce7",
    "--kaiju-status-attention": "#a14b05",
    "--kaiju-status-attention-bg": "#fef3c7",
    "--kaiju-status-failed": "#b91c1c",
    "--kaiju-status-failed-bg": "#fee2e2",
    "--admin-danger": "#a4161a",
    "--admin-danger-bg": "#fdecec",
    "--kaiju-when-light": "block",
    "--kaiju-when-dark": "none",
  },
  dark: {
    "--kaiju-status-running": "#4ade80",
    "--kaiju-status-running-bg": "#052e16",
    "--kaiju-status-attention": "#fbbf24",
    "--kaiju-status-attention-bg": "#422006",
    "--kaiju-status-failed": "#f87171",
    "--kaiju-status-failed-bg": "#450a0a",
    "--admin-danger": "#ff8a8a",
    "--admin-danger-bg": "#3a1c1e",
    "--kaiju-when-light": "none",
    "--kaiju-when-dark": "block",
  },
} as const;

export const PREVIEW_FIXED_TOKENS = Object.keys(
  FIXED.light,
) as readonly (keyof typeof FIXED.light)[];

/** theme.css's aliases of the brand tokens, declared again on each root (see above). */
const ALIASES = [
  ["--admin-accent", "var(--kaiju-brand-link)"],
  ["--kaiju-status-accent", "var(--kaiju-brand-primary)"],
  ["--kaiju-status-accent-fg", "var(--kaiju-brand-primary-fg)"],
] as const;

type Decls = readonly (readonly [string, string])[];

const rule = (selector: string, decls: Decls): string =>
  `${selector} {\n${decls.map(([n, v]) => `  ${n}: ${v};\n`).join("")}}\n`;

const schemeDecls = (scheme: "light" | "dark"): Decls => [
  ["color-scheme", scheme],
  ...Object.entries(PRESETS.default[scheme]),
  ...Object.entries(FIXED[scheme]),
];

const shared: Decls = [
  ...RADIUS_TOKENS.map((t) => [t, RADIUS_SCALES.soft[t]] as const),
  ["--kaiju-font-sans", FONT_STACK_VALUES.system],
  ["--kaiju-font-mono", SYSTEM_MONO_STACK],
  ...ALIASES,
];

/** The preview's whole stylesheet for `theme`; "" if it ever left the allow-list. */
export function previewCss(theme: ThemeSettings): string {
  const light = `#${PREVIEW_IDS.light}`;
  const dark = `#${PREVIEW_IDS.dark}`;
  const css = [
    rule(`${light}, [${SWATCH_ATTRIBUTE}="light"]`, [...schemeDecls("light"), ...shared]),
    rule(dark, shared),
    rule(`${dark}[data-theme="dark"], [${SWATCH_ATTRIBUTE}="dark"]`, schemeDecls("dark")),
    brandingCss(theme, light),
    brandingCss(theme, dark),
  ].join("");
  return BRANDING_CSS_ALLOWED.test(css) ? css : "";
}
