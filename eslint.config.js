// @ts-check
/**
 * ESLint flat config.
 *
 * This file did not exist. `npm run lint` was declared in package.json, eslint
 * and six plugins were installed and pinned, and running it printed "ESLint
 * couldn't find an eslint.config.js file" — so the lint gate had never run
 * once, on any commit, while looking from the outside exactly like a project
 * that lints.
 *
 * THE TYPE-STRIPPING RULES ARE THE POINT. `npm test` and every script run
 * through `node --experimental-strip-types`, which ERASES type syntax rather
 * than compiling it. Three TypeScript constructs cannot survive that, because
 * erasing them also erases runtime behaviour:
 *
 *   - parameter properties — `constructor(readonly code: string)` — the
 *     assignment lives inside the type annotation, so stripping deletes it and
 *     the field is silently undefined at runtime;
 *   - `enum`, which emits a real object;
 *   - `namespace`, likewise.
 *
 * `lib/vision/io.ts` documents this in a comment and asks that nothing in the
 * repository use them. A comment is not a gate: `tsc --noEmit` accepts all
 * three happily, so the first one to be written would pass typecheck, pass
 * build, and fail at runtime only on whichever path the test suite happened to
 * exercise. These rules turn that convention into something checked.
 */

import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "tests/__output__/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // --- Node type-stripping compatibility. See the module note. ----------
      "@typescript-eslint/no-namespace": "error",
      "@typescript-eslint/parameter-properties": ["error", { prefer: "class-property" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message:
            "`enum` emits a runtime object and cannot survive `node --experimental-strip-types`, which is how the tests run. Use a union type plus a frozen const object.",
        },
      ],

      // An unused import in this codebase is usually a stage that was wired up
      // and then quietly bypassed — which is exactly how `rectifyPage` and
      // `extractCrop` came to be imported, documented as load-bearing, and
      // never called. Leading underscore is the deliberate opt-out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      // `any` disables exactly the checking that catches a coordinate-frame
      // mix-up, which is this codebase's most expensive class of bug.
      "@typescript-eslint/no-explicit-any": "error",

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  // --- React / Next ------------------------------------------------------
  {
    files: ["app/**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
      "@next/next": nextPlugin,
    },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat["jsx-runtime"].rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },

  // Scripts and tests report through stdout; that IS their output.
  {
    files: ["scripts/**/*.ts", "tests/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
