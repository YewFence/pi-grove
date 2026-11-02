import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/helpers/setup.ts"],
    hookTimeout: 30_000,
    testTimeout: 15_000,
    maxWorkers: Math.max(1, Math.min(4, Math.floor(availableParallelism() * 0.6))),
    unstubGlobals: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
