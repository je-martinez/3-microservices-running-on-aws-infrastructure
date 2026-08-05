import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vite transpiles the `emails/*.tsx` templates with esbuild, which defaults
  // to the CLASSIC JSX runtime (React.createElement) and needs React in scope.
  // The templates don't import React, so without this the render throws
  // "React is not defined" at runtime — tsconfig's `jsx` setting does not reach
  // Vite. Mirrored in tsconfig.json and scripts/build.mjs.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "#shared/": fileURLToPath(new URL("./src/shared/", import.meta.url)),
      "#pipeline/": fileURLToPath(new URL("./src/pipeline/", import.meta.url)),
      "#domain/": fileURLToPath(new URL("./src/domain/", import.meta.url)),
      "#email/": fileURLToPath(new URL("./src/email/", import.meta.url)),
      "#handlers/": fileURLToPath(new URL("./src/handlers/", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
});
