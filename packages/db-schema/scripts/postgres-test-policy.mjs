import { spawnSync } from "node:child_process";

export const POSTGRES_TEST_GLOBS = [
  "**/*.postgres.test.ts",
  "**/*-postgres.test.ts",
  "**/*_postgres.test.ts",
  "**/*.postgres.integration.test.ts",
];
export const FULL_SLICE_GLOB = "tests/runner/*_full_slice_postgres.test.ts";
export const TEST_SCHEMA_PATTERN = "^[a-z][a-z0-9_]*_[0-9]{13}_[a-z0-9]+$";

export function isPostgresTestFile(path) {
  return /(?:[._-]postgres\.test\.ts|\.postgres\.integration\.test\.ts)$/.test(path);
}

export function dockerAvailable() {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 }).status === 0;
}

export function decidePostgresTests(env = process.env, probeDocker = dockerAvailable) {
  const ciValue = (env.CI ?? "").trim().toLowerCase();
  const isCI = ciValue !== "" && ciValue !== "0" && ciValue !== "false";
  const backendAvailable = Boolean(env.TEST_DATABASE_URL?.trim()) || probeDocker();
  return {
    isCI,
    backendAvailable,
    excludePostgres: !isCI && !backendAvailable,
    excludeFullSlice: !isCI && env.SOULSTREAM_RUN_FULL_SLICE !== "1",
  };
}

export function requirePostgresBackendInCI(path, env = process.env, probeDocker = dockerAvailable) {
  if (!isPostgresTestFile(path)) return;
  const { isCI, backendAvailable } = decidePostgresTests(env, probeDocker);
  if (isCI && !backendAvailable) {
    throw new Error("PostgreSQL tests require TEST_DATABASE_URL or a running Docker daemon; set TEST_DATABASE_URL or start Docker.");
  }
}

export function postgresVitestOptions(env = process.env, probeDocker = dockerAvailable) {
  const decision = decidePostgresTests(env, probeDocker);
  const exclude = [
    ...(decision.excludePostgres ? POSTGRES_TEST_GLOBS : []),
    ...(decision.excludeFullSlice ? [FULL_SLICE_GLOB] : []),
  ];
  if (exclude.length) {
    const reasons = [
      ...(decision.excludePostgres ? ["PostgreSQL tests: no TEST_DATABASE_URL or working docker"] : []),
      ...(decision.excludeFullSlice ? ["runner full slices: SOULSTREAM_RUN_FULL_SLICE is not 1"] : []),
    ];
    process.stderr.write(`Skipping ${reasons.join("; ")}. CI does not skip; set TEST_DATABASE_URL, start docker, or set SOULSTREAM_RUN_FULL_SLICE=1 as needed.\n`);
  }
  return { exclude, passWithNoTests: exclude.length > 0 };
}
