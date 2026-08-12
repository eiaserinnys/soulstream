import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SOULSTREAM_TEST_HARNESS_LABEL,
  startPostgresTestContainer,
} from "../../../packages/db-schema/scripts/postgres-test-container.mjs";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const docker = vi.mocked(execFileSync);
const NOW = new Date("2026-08-13T00:00:00.000Z");

describe("PostgreSQL test container lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    docker.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaps only labeled containers older than two hours before starting a replacement", () => {
    docker.mockImplementation((command, args) => {
      expect(command).toBe("docker");
      const dockerArgs = args as string[];
      if (dockerArgs[0] === "ps") return "stale-id\nyoung-id\n";
      if (dockerArgs[0] === "inspect" && dockerArgs.at(-1) === "stale-id") {
        return "2026-08-12T21:59:59.000000000Z\n";
      }
      if (dockerArgs[0] === "inspect" && dockerArgs.at(-1) === "young-id") {
        return "2026-08-12T22:00:01.000000000Z\n";
      }
      if (dockerArgs[0] === "run") return "fresh-id\n";
      if (dockerArgs[0] === "port") return "127.0.0.1:55432\n";
      if (dockerArgs[0] === "rm") return "";
      throw new Error(`unexpected docker call: ${dockerArgs.join(" ")}`);
    });

    const lease = startPostgresTestContainer({
      user: "test_user",
      password: "test_password",
      database: "test_database",
    });

    expect(lease.reapedContainerIds).toEqual(["stale-id"]);
    expect(lease.port).toBe("55432");
    const calls = docker.mock.calls.map(([, args]) => args as string[]);
    const staleRemoval = calls.findIndex((args) =>
      args[0] === "rm" && args.includes("stale-id"));
    const creation = calls.findIndex((args) => args[0] === "run");
    expect(staleRemoval).toBeGreaterThanOrEqual(0);
    expect(staleRemoval).toBeLessThan(creation);
    expect(calls[creation]).toEqual(expect.arrayContaining([
      "--label",
      SOULSTREAM_TEST_HARNESS_LABEL,
    ]));

    lease.stop();
    expect(docker).toHaveBeenCalledWith(
      "docker",
      ["rm", "-f", "-v", "fresh-id"],
      expect.any(Object),
    );
  });

  it("shares one exit and signal hook set across active containers", () => {
    docker.mockImplementation((_command, args) => {
      const dockerArgs = args as string[];
      if (dockerArgs[0] === "ps") return "";
      if (dockerArgs[0] === "run") {
        return docker.mock.calls.filter(([, calledArgs]) =>
          (calledArgs as string[])[0] === "run").length === 1
          ? "first-id\n"
          : "second-id\n";
      }
      if (dockerArgs[0] === "port") return "127.0.0.1:55432\n";
      if (dockerArgs[0] === "rm") return "";
      throw new Error(`unexpected docker call: ${dockerArgs.join(" ")}`);
    });
    const baseline = {
      exit: process.listenerCount("exit"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };

    const first = startPostgresTestContainer({
      user: "test_user",
      password: "test_password",
      database: "test_database",
    });
    const second = startPostgresTestContainer({
      user: "test_user",
      password: "test_password",
      database: "test_database",
    });

    expect(process.listenerCount("exit")).toBe(baseline.exit + 1);
    expect(process.listenerCount("SIGINT")).toBe(baseline.SIGINT + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.SIGTERM + 1);
    first.stop();
    expect(process.listenerCount("exit")).toBe(baseline.exit + 1);
    second.stop();
    expect(process.listenerCount("exit")).toBe(baseline.exit);
    expect(process.listenerCount("SIGINT")).toBe(baseline.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.SIGTERM);
  });
});

describe("detached Docker test container inventory", () => {
  it("routes every direct docker run through the shared lifecycle helper", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const offenders = ["orch-server-ts/tests", "soul-server-ts/tests"]
      .flatMap((directory) => findTypeScriptFiles(path.join(repositoryRoot, directory)))
      .filter((file) => /execFileSync\(\s*["']docker["']\s*,\s*\[\s*["']run["']/s
        .test(readFileSync(file, "utf8")))
      .map((file) => path.relative(repositoryRoot, file))
      .sort();

    expect(offenders).toEqual([]);
  });
});

function findTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTypeScriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  });
}
