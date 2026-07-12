import { defineWorkspace } from "vitest/config";

// Root workspace definition — lets `pnpm exec vitest` run the entire suite at
// once from the repo root, discovering every package + the retained
// CLI-contract harness under tools/. CI uses `pnpm -r test` (each package runs
// its own `vitest run`); this file is the convenience aggregate. Every project
// passes with no tests so placeholder packages (empty in Phase 0) do not fail.
export default defineWorkspace([
  {
    test: {
      name: "packages",
      root: "./packages",
      include: ["*/{src,test}/**/*.test.ts"],
      environment: "node",
      passWithNoTests: true,
    },
  },
  {
    test: {
      name: "apps",
      root: "./apps",
      include: ["*/{src,test}/**/*.test.ts"],
      environment: "node",
      passWithNoTests: true,
    },
  },
  {
    test: {
      name: "tools",
      root: "./tools",
      include: ["**/*.test.ts"],
      environment: "node",
      passWithNoTests: true,
    },
  },
]);
