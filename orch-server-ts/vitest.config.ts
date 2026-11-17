import { configDefaults, defineConfig } from "vitest/config";
import { postgresVitestOptions } from "../packages/db-schema/scripts/postgres-test-policy.mjs";

const postgres = postgresVitestOptions();

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...postgres.exclude],
    passWithNoTests: postgres.passWithNoTests,
    setupFiles: ["../soul-server-ts/tests/setup/require_postgres_in_ci.ts"],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
