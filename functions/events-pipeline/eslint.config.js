// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Flat config (ESLint 9+ style). Type-aware linting is scoped to `src/` and
// `tests/` via `tseslint.config`'s project service, which resolves each
// file's tsconfig automatically — this repo has a single `tsconfig.json`
// covering `src/**/*.ts`; tests are linted syntactically (no separate
// tsconfig includes them, see `vitest.config.ts` for how they're type-checked
// instead via `vitest`/`tsc --noEmit` at the editor level).
export default tseslint.config(
  {
    // Compiled output and dependencies are never linted.
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Build tooling runs on Node, not in the Lambda: it needs Node's globals
    // (console, URL, process) that the default config does not declare.
    files: ["scripts/**/*.mjs", "*.config.js", "*.config.ts"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
);
