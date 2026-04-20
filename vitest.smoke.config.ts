import { defineConfig } from "vitest/config";
import {
  sharedCoverage,
  sharedResolve,
  smokeInclude,
} from "./vitest.patterns.js";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: smokeInclude,
    coverage: sharedCoverage,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: sharedResolve,
});
