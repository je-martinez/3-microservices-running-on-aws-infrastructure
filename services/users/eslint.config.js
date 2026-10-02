// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Flat config (ESLint 9+ style). Linting is syntactic only; type-checking of
// `src/` and `tests/` is `pnpm typecheck` (tsconfig.test.json).
export default tseslint.config(
  {
    // Generated Prisma client, compiled output, and dependencies are never linted.
    ignores: ["dist/**", "src/generated/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Path aliases (#shared/*, #features/*) and intentional `unknown`/`any`
      // narrowing at DI/Prisma boundaries (see prisma-extensions.ts) make the
      // stricter type-checked rule set too noisy for this codebase's current
      // patterns; recommended (non-type-checked) rules catch real bugs
      // (unused vars, no-undef, etc.) without requiring a rewrite of those
      // intentionally loose boundaries.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
