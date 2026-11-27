import { describe, expect, it, vi } from "vitest";

import {
  decidePostgresTests,
  isPostgresTestFile,
  postgresVitestOptions,
  requirePostgresBackendInCI,
  TEST_SCHEMA_PATTERN,
} from "../../../packages/db-schema/scripts/postgres-test-policy.mjs";

describe("PostgreSQL test policy", () => {
  it("uses a supplied DB or a working Docker daemon and probes Docker only when needed", () => {
    const docker = vi.fn(() => true);
    expect(decidePostgresTests({ TEST_DATABASE_URL: "postgres://test" }, docker).backendAvailable).toBe(true);
    expect(docker).not.toHaveBeenCalled();
    expect(decidePostgresTests({}, docker).backendAvailable).toBe(true);
    expect(decidePostgresTests({}, () => false).backendAvailable).toBe(false);
  });

  it("excludes DB files locally without a backend and full slices unless opted in", () => {
    const absent = decidePostgresTests({}, () => false);
    expect(absent.excludePostgres).toBe(true);
    expect(absent.excludeFullSlice).toBe(true);
    expect(decidePostgresTests({ TEST_DATABASE_URL: "test" }, () => false).excludeFullSlice).toBe(true);
    expect(decidePostgresTests({ SOULSTREAM_RUN_FULL_SLICE: "1" }, () => true).excludeFullSlice).toBe(false);
    for (const CI of ["", "0", "false", "FALSE"]) {
      expect(decidePostgresTests({ CI }, () => false).excludePostgres).toBe(true);
    }
  });

  it("requires the backend in CI and never excludes full slices there", () => {
    const ci = decidePostgresTests({ CI: "true" }, () => false);
    expect(ci.isCI).toBe(true);
    expect(ci.excludePostgres).toBe(false);
    expect(ci.excludeFullSlice).toBe(false);
    expect(() => requirePostgresBackendInCI("x.postgres.test.ts", { CI: "true" }, () => false))
      .toThrow(/TEST_DATABASE_URL.*Docker/);
    expect(() => requirePostgresBackendInCI("unit.test.ts", { CI: "true" }, () => false)).not.toThrow();
    expect(() => requirePostgresBackendInCI("x.postgres.test.ts", { CI: "true", TEST_DATABASE_URL: "test" }, () => false)).not.toThrow();
  });

  it("does not probe Docker from the CI guard outside CI", () => {
    const docker = vi.fn(() => false);
    for (const CI of ["", "0", "false"]) {
      requirePostgresBackendInCI("x.postgres.test.ts", { CI }, docker);
    }
    expect(docker).not.toHaveBeenCalled();
  });

  it("excludes Docker-only files, not general ones, when a supplied DB has no working Docker outside CI", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const noDocker = postgresVitestOptions({ TEST_DATABASE_URL: "postgres://test" }, () => false);
      expect(noDocker.exclude).toContain("**/*.docker.postgres.test.ts");
      expect(noDocker.exclude).not.toContain("**/*.postgres.test.ts");
      const withDocker = postgresVitestOptions({ TEST_DATABASE_URL: "postgres://test" }, () => true);
      expect(withDocker.exclude).not.toContain("**/*.docker.postgres.test.ts");
      expect(withDocker.exclude).not.toContain("**/*.postgres.test.ts");
    } finally {
      stderr.mockRestore();
    }
  });

  it("never excludes Docker-only files in CI", () => {
    const docker = vi.fn(() => false);
    expect(postgresVitestOptions({ CI: "true" }, docker).exclude).not.toContain("**/*.docker.postgres.test.ts");
    docker.mockClear();
    expect(postgresVitestOptions({ CI: "true", TEST_DATABASE_URL: "postgres://test" }, docker).exclude)
      .not.toContain("**/*.docker.postgres.test.ts");
    expect(docker).not.toHaveBeenCalled();
  });

  it("recognizes the four filename forms and only generated test schema names", () => {
    for (const name of ["x.postgres.test.ts", "x-postgres.test.ts", "x_postgres.test.ts", "x.postgres.integration.test.ts"]) {
      expect(isPostgresTestFile(name)).toBe(true);
    }
    expect(isPostgresTestFile("x.docker.postgres.test.ts")).toBe(true);
    expect(isPostgresTestFile("x.integration.test.ts")).toBe(false);
    const schema = new RegExp(TEST_SCHEMA_PATTERN);
    for (const name of ["page_1700000000000_abc123", "board_yjs_seed_1700000000000_abcd"]) expect(schema.test(name)).toBe(true);
    for (const name of ["public", "page_existing", "page_123_x", "page_1700000000000_"]) expect(schema.test(name)).toBe(false);
  });
});
