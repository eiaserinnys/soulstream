import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it("checks counts only and scrubs dead runners while retaining live runner files", async () => {
  const root = await mkdtemp(join(tmpdir(), "scrub-runner-"));
  directories.push(root);
  const secret = randomUUID();
  const registry = join(root, "mcp-registry.yaml");
  await writeFile(registry, `servers:\n  - id: external\n    type: streamable_http\n    url: https://example.test/mcp\n    headers:\n      X-Key:\n        env: TEST_SCRUB_SECRET\n`);
  for (const name of ["live", "dead", "unknown"]) {
    const dir = join(root, name);
    await mkdir(dir);
    const paths = {
      sessionDirectory: dir, databasePath: join(dir, "runner.sqlite"), socketPath: join(dir, "runner.sock"),
      pidPath: join(dir, "runner.pid"), lockPath: join(dir, "runner.lock"), configPath: join(dir, "runner-config.json"),
    };
    await writeFile(paths.configPath, JSON.stringify({
      schemaVersion: 1, sessionId: name, backend: "codex",
      agent: { id: "test", name: "Test", backend: "codex", workspace_dir: root }, paths,
      codeSha: "test", snapshotPath: root, codexAdapterMode: "sdk", claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 1000, claudeRuntimeMaxEntries: 1, claudeRuntimeTurnTimeoutMs: 1000,
      internalMcpUrl: "http://127.0.0.1:1234/mcp", codexHome: null, rolloutRoot: null,
      resolvedMcpServers: [{ type: "streamable_http", name: "external", url: "https://example.test/mcp", headers: { "X-Key": secret } }],
    }));
    if (name !== "unknown") await writeFile(paths.pidPath, String(name === "live" ? process.pid : 2147483647));
    await writeFile(join(dir, "claude-mcp-config-test.json"), "{}");
  }
  await mkdir(join(root, "orphan"));
  await writeFile(join(root, "orphan", "claude-mcp-config-test.json"), "{}");
  const args = ["--import", "tsx", join(process.cwd(), "scripts/scrub_runner_config_secrets.ts"),
    "--state-dir", root, "--agents-config-path", join(root, "agents.yaml")];
  const env = { ...process.env, TEST_SCRUB_SECRET: secret };
  const checked = await exec(process.execPath, [...args, "--check"], { env });
  expect(checked.stdout.includes(secret)).toBe(false);
  expect(JSON.parse(checked.stdout)).toEqual({ configs: 3, withRefs: 0, withPlaintextSecrets: 3, plaintextWithLiveRunner: 2, claudeFiles: 4 });
  const applied = await exec(process.execPath, [...args, "--apply"], { env });
  expect(applied.stdout.includes(secret)).toBe(false);
  expect(JSON.parse(applied.stdout)).toEqual({ configs: 3, withRefs: 1, withPlaintextSecrets: 2, plaintextWithLiveRunner: 2, claudeFiles: 3 });
  const dead = await readFile(join(root, "dead", "runner-config.json"), "utf8");
  const live = await readFile(join(root, "live", "runner-config.json"), "utf8");
  expect(dead.includes(secret)).toBe(false);
  expect(live.includes(secret)).toBe(true);
  expect(JSON.parse(dead).mcpSecretRefs).toEqual([{ server: "external", field: "headers", key: "X-Key", env: "TEST_SCRUB_SECRET" }]);
  await expect(readFile(join(root, "dead", "claude-mcp-config-test.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, "live", "claude-mcp-config-test.json"))).resolves.toBeDefined();
});
