import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

export default defineConfig({
  // CONTRACT: Keep this plugin. Vitest's default esbuild transform drops
  // `design:paramtypes`, so Nest's type-based DI injects `undefined` in tests
  // while `pnpm build` (tsc) works — a failure that only ever shows up here.
  // Options come from .swcrc. See [[dependency-injection]]
  plugins: [swc.vite()],
  resolve: {
    alias: {
      "#shared/": fileURLToPath(new URL("./src/shared/", import.meta.url)),
      "#features/": fileURLToPath(new URL("./src/features/", import.meta.url)),
      "#config/": fileURLToPath(new URL("./src/config/", import.meta.url)),
      "#notifications/": fileURLToPath(new URL("./src/notifications/", import.meta.url)),
      "#users/": fileURLToPath(new URL("./src/users/", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
});
