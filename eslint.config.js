import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const NO_LOOPBACK_TESTING = {
  name: "@kobe/address-policy/testing",
  message: "Test files only: production code never allows loopback (KOBE-694).",
};
const NO_SANDBOX_WIRE = {
  name: "@kobe/protocol/sandbox-wire",
  message: "The sandbox wire stays out of the web bundle (KOBE-720).",
};
const NO_DEEP_PROTOCOL = {
  group: ["@kobe/protocol/dist/*", "@kobe/protocol/src/*"],
  message: "Import @kobe/protocol through its exports (KOBE-720).",
};
const WEB_FILES = [
  "apps/web/**/*.ts",
  "apps/web/**/*.tsx",
  "apps/web/**/*.mjs",
  "apps/web/**/*.js",
];
const TYPED_FILES = ["services/*/src/**/*.ts", "packages/*/src/**/*.ts"];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      // Copied from pdfjs-dist before each web build (KOBE-801).
      "apps/web/public/pdfjs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // KOBE-722: type-aware promise rules for services and packages only. Scoped to `src/`, which
    // every service and package tsconfig includes (tests too), so the project service never has to
    // fall back to a default project; the rest of the repo stays on the faster untyped lint.
    files: TYPED_FILES,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // Tests poke at loosely typed HTTP/JSON payloads; production code stays strict.
    files: ["**/*.test.ts", "**/*.test-helpers.ts", "**/testing/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // CE13 (KOBE-203): navigation and actions in the chat shell are IconActions with tooltips;
    // content (titles, names, markers, tables) stays text but is never a bare text link. Caught:
    // an <a> or next/link <Link> with a letter or digit anywhere inside it (nested elements too),
    // written as JSX text, a {"string"} or a {`template`}. Allowed: prose links through InlineLink
    // and menu items through MenuLink (components/shell/text-links.tsx), which render children.
    files: ["apps/web/components/chat/**/*.tsx", "apps/web/components/shell/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXElement:matches([openingElement.name.name='a'], [openingElement.name.name='Link']) " +
            ":matches(JSXText[value=/[\\p{L}\\p{N}]/u], " +
            "JSXElement > JSXExpressionContainer > Literal[value=/[\\p{L}\\p{N}]/u], " +
            "JSXElement > JSXExpressionContainer > TemplateLiteral)",
          message:
            "No bare text links in the chat shell (CE13): use IconAction from components/shell/icon-action.tsx.",
        },
      ],
    },
  },
  {
    // KOBE-694: the loopback-allowing address checker is a test double; services never use it.
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js"],
    ignores: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.test-helpers.ts",
      "**/testing/**",
      "packages/address-policy/src/testing.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [NO_LOOPBACK_TESTING],
        },
      ],
    },
  },
  {
    // KOBE-720: the sandbox wire (frame schemas) never ships to the browser. It is only exported
    // from `@kobe/protocol/sandbox-wire`, which web code may not import.
    files: WEB_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [NO_SANDBOX_WIRE], patterns: [NO_DEEP_PROTOCOL] },
      ],
    },
  },
  {
    // This block replaces the KOBE-694 rule for web production files, so it repeats that path.
    files: WEB_FILES,
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.test-helpers.ts", "**/testing/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [NO_SANDBOX_WIRE, NO_LOOPBACK_TESTING], patterns: [NO_DEEP_PROTOCOL] },
      ],
    },
  },
  prettier,
);
