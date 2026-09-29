import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDirSync } from "../helpers/temp_dir.js";

import { runDatabaseReleaseCli } from
  "../../../packages/db-schema/scripts/database-release-cli.mjs";

const MIGRATE = fileURLToPath(new URL(
  "../../../packages/db-schema/scripts/migrate.mjs",
  import.meta.url,
));
const FOLDER_WRITER = fileURLToPath(new URL(
  "../../../orch-server-ts/scripts/apply-folder-storage.mjs",
  import.meta.url,
));
const CENTRAL_MANIFEST = fileURLToPath(new URL(
  "../../../deploy/release-manifest.json",
  import.meta.url,
));
const CENTRAL_CONTRACT = fileURLToPath(new URL(
  "../../../deploy/database-release-central.json",
  import.meta.url,
));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory(prefix: string) {
  const directory = makeTempDirSync(prefix);
  directories.push(directory);
  return directory;
}

describe("database release CLI and direct writer boundaries", () => {
  it("loads a paired database sidecar as the single writer and subphase contract", async () => {
    const directory = tempDirectory("release-cli-contract-");
    const manifestPath = join(directory, "release-manifest.json");
    const contractPath = join(directory, "database-release.json");
    writeFileSync(manifestPath, JSON.stringify({
      environment_service: "writer",
      migration: {},
    }), "utf8");
    writeFileSync(contractPath, JSON.stringify({
      schema_version: "soulstream.database-release-manifest.v2",
      affected_services: ["writer"],
      required_subphases: ["board"],
    }), "utf8");
    const env: Record<string, string> = {};
    const observed: Record<string, string>[] = [];

    await expect(runDatabaseReleaseCli(async (
      _command: string,
      options: { env: Record<string, string> },
    ) => {
      observed.push({ ...options.env });
      return { ok: true };
    }, {
      argv: ["probe", "--manifest", manifestPath, "--database-contract", contractPath],
      env,
      stdout: () => undefined,
      stderr: () => undefined,
    })).resolves.toBe(0);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      HANIEL_DATABASE_AFFECTED_SERVICES: '["writer"]',
      HANIEL_DATABASE_REQUIRED_SUBPHASES: '["board"]',
      HANIEL_MANIFEST_DIGEST: expect.stringMatching(/^[a-f0-9]{64}$/),
      HANIEL_DATABASE_CONTRACT_DIGEST: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("fails closed when a Haniel manifest is not paired with its database sidecar", async () => {
    const directory = tempDirectory("release-cli-unpaired-");
    const manifestPath = join(directory, "release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      environment_service: "writer",
      migration: {},
    }), "utf8");
    const errors: string[] = [];
    const runner = async () => ({ ok: true });

    await expect(runDatabaseReleaseCli(runner, {
      argv: ["probe", "--manifest", manifestPath],
      env: {},
      stdout: () => undefined,
      stderr: (value: string) => errors.push(value),
    })).resolves.toBe(1);
    expect(errors.join("\n")).toContain("manifest and database contract must be paired");
  });

  it("uses the actual central Haniel affected writer set exactly", async () => {
    const env: Record<string, string> = {};
    await expect(runDatabaseReleaseCli(async (
      _command: string,
      options: { env: Record<string, string> },
    ) => ({ affected_services: JSON.parse(options.env.HANIEL_DATABASE_AFFECTED_SERVICES) }), {
      argv: [
        "probe", "--manifest", CENTRAL_MANIFEST,
        "--database-contract", CENTRAL_CONTRACT,
      ],
      env,
      stdout: () => undefined,
      stderr: () => undefined,
    })).resolves.toBe(0);
    expect(JSON.parse(env.HANIEL_DATABASE_AFFECTED_SERVICES)).toEqual([
      "soulstream-orch-server",
      "soulstream-soul-server-ts",
    ]);
  });

  it.each([
    ["HANIEL_MANIFEST_DIGEST", "0".repeat(64)],
    ["HANIEL_DATABASE_CONTRACT_DIGEST", "1".repeat(64)],
    ["HANIEL_DATABASE_AFFECTED_SERVICES", '["poisoned-writer"]'],
    ["HANIEL_DATABASE_REQUIRED_SUBPHASES", '["poisoned-subphase"]'],
  ])("rejects poisoned %s before invoking the release runner", async (name, value) => {
    const env: Record<string, string> = { [name]: value };
    const errors: string[] = [];
    let invoked = 0;
    const code = await runDatabaseReleaseCli(async () => {
      invoked += 1;
      return { ok: true };
    }, {
      argv: [
        "probe", "--manifest", CENTRAL_MANIFEST,
        "--database-contract", CENTRAL_CONTRACT,
      ],
      env,
      stdout: () => undefined,
      stderr: (line: string) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(invoked).toBe(0);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0])).toMatchObject({
      ok: false,
      error: { code: "JOURNAL_GATE_FAILED" },
    });
  });

  it.each(["success", "failure"])(
    "emits one bounded recursively redacted %s JSON object",
    async (outcome) => {
      const identity = `AUTH_ID=${"x".repeat(20_000)}`;
      const secret = "credential-value-must-not-appear";
      const lines: string[] = [];
      const env: Record<string, string> = {
        AUTH_TOKEN: secret,
        HANIEL_REQUEST_ID: identity,
        HANIEL_RELEASE_ID: `release-${identity}`,
        HANIEL_DATABASE_OPERATION: `operation-${identity}`,
        HANIEL_PREVIOUS_HEAD: `previous-${identity}`,
        HANIEL_TARGET_HEAD: `target-${identity}`,
        HANIEL_BACKUP_DIR: `/tmp/PASSWORD=${secret}/${identity}`,
        DATABASE_URL: `postgresql://user:${secret}@localhost/release_test`,
      };
      const code = await runDatabaseReleaseCli(async () => {
        if (outcome === "failure") {
          throw new Error(
            `SECRET=${secret} postgresql://user:${secret}@localhost/release_test ${identity}`,
          );
        }
        return {
          schema_version: "soulstream.database-release.v1",
          ok: true,
          request_id: identity,
          release_id: secret,
          nested: { token: secret, values: [identity, `AUTH=${secret}`] },
        };
      }, {
        argv: ["probe"],
        env,
        stdout: (line: string) => lines.push(line),
        stderr: (line: string) => lines.push(line),
      });
      expect(code).toBe(outcome === "success" ? 0 : 1);
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();
      expect(Buffer.byteLength(lines[0], "utf8")).toBeLessThanOrEqual(32_768);
      expect(lines[0]).not.toContain(secret);
      expect(lines[0]).not.toContain(identity);
      expect(lines[0]).not.toContain(`user:${secret}@`);
    },
  );

  it("keeps an oversized nested status as one valid bounded JSON object", async () => {
    const lines: string[] = [];
    const code = await runDatabaseReleaseCli(async () => ({
      schema_version: "soulstream.database-release.v1",
      ok: true,
      phase: "verify",
      status: {
        values: Array.from({ length: 64 }, (_, index) => ({
          index,
          detail: "x".repeat(20_000),
        })),
      },
    }), {
      argv: ["verify"],
      env: {},
      stdout: (line: string) => lines.push(line),
      stderr: (line: string) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(Buffer.byteLength(lines[0], "utf8")).toBeLessThanOrEqual(32_768);
  });

  it.each(["apply", "initialize", "fresh-install", "recover"])(
    "uses one bounded redacted failure envelope for direct migrate %s",
    (mode) => {
      const secret = `AUTHXYZ-${mode}`;
      const directory = tempDirectory("release-cli-secret-");
      const result = spawnSync(process.execPath, [MIGRATE, mode], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          HANIEL_BACKUP_DIR: join(directory, secret),
          AUTH_TOKEN: secret,
          DATABASE_URL: `postgresql://user:${secret}@127.0.0.1:1/release_test`,
        },
        timeout: 5_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeLessThan(8_192);
      expect(result.stderr).not.toContain(secret);
      const payload = JSON.parse(result.stderr);
      expect(payload).toMatchObject({
        schema_version: "soulstream.database-release.v1",
        ok: false,
        phase: mode,
        error: { code: expect.any(String), message: expect.any(String) },
      });
    },
  );

  it("requires the document writer to enter through the existing subphase gate", () => {
    const source = readFileSync(FOLDER_WRITER, "utf8");
    expect(source).toContain("assertDatabaseReleaseSubphaseGate");
    expect(source).toContain("folder_storage_documents");
  });

  it("fails direct document conversion with one JSON error before loading the converter", () => {
    const directory = tempDirectory("release-folder-direct-");
    const result = spawnSync(process.execPath, [FOLDER_WRITER, "--documents"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        HANIEL_SERVICE_CWD: directory, HANIEL_BACKUP_DIR: directory },
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    const failure = JSON.parse(lines[0]);
    expect(failure).toMatchObject({ ok: false, error: { code: "DATABASE_RELEASE_FAILED" } });
    expect(failure.error.message).toContain("database-release.json");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stderr).not.toContain("DATABASE_URL is required");
  });

  it("redacts and bounds an actual folder deployment failure", () => {
    const directory = tempDirectory("release-folder-error-");
    const secret = "folder-release-secret-value";
    writeFileSync(join(directory, ".env.soul-server-ts"), "\n", "utf8");
    const result = spawnSync(process.execPath, [FOLDER_WRITER], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        HANIEL_SERVICE_CWD: directory, HANIEL_BACKUP_DIR: directory,
        HANIEL_RELEASE_ID: `AUTH=${secret}`, AUTH_TOKEN: secret },
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0], "utf8")).toBeLessThanOrEqual(32_768);
    expect(JSON.parse(lines[0])).toMatchObject({
      schema_version: "soulstream.database-release.v1", ok: false, phase: "apply",
      error: { message: expect.stringContaining("DATABASE_URL is required") },
    });
    expect(result.stderr).not.toContain(secret);
  });

  it("rejects a mismatched release identity before opening the database", () => {
    const directory = tempDirectory("release-folder-identity-");
    const result = spawnSync(process.execPath, [FOLDER_WRITER], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        HANIEL_SERVICE_CWD: directory, HANIEL_MANIFEST_DIGEST: "0".repeat(64) },
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      ok: false, error: { code: "JOURNAL_GATE_FAILED" },
    });
    expect(result.stderr).not.toContain("DATABASE_URL is required");
  });
});
