import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { RunnerWriterLock } from "../../src/runner/runner_writer_lock.js";
import { runnerSessionMutationLockPath } from "../../src/runner/runner_session_mutation_lock.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(root: string, name: string, secret: string, old = true) {
  const dir = join(root, name);
  await mkdir(dir);
  const paths = { sessionDirectory: dir, databasePath: join(dir, "runner.sqlite"), socketPath: join(dir, "runner.sock"),
    pidPath: join(dir, "runner.pid"), lockPath: join(dir, "runner.lock"), configPath: join(dir, "runner-config.json") };
  await writeFile(paths.configPath, JSON.stringify({
    schemaVersion: 1, sessionId: name, backend: "codex",
    agent: { id: "test", name: "Test", backend: "codex", workspace_dir: root }, paths,
    codeSha: "test", snapshotPath: root, codexAdapterMode: "sdk", claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 1000, claudeRuntimeMaxEntries: 1, claudeRuntimeTurnTimeoutMs: 1000,
    internalMcpUrl: "http://127.0.0.1:1234/mcp", codexHome: null, rolloutRoot: null,
    resolvedMcpServers: [{ type: "streamable_http", name: "external", url: "https://example.test/mcp", headers: secret ? { "X-Key": secret } : {} }],
  }));
  await writeFile(join(dir, "claude-mcp-config-test.json"), "{}");
  if (old) { const date = new Date(Date.now() - 180_000); await utimes(paths.configPath, date, date); }
  return paths;
}
function run(root: string, mode: "--check" | "--apply", extra: string[] = []) {
  return exec(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts/scrub_runner_config_secrets.ts"),
    "--", "--state-dir", root, "--agents-config-path", join(root, "ignored.yaml"), mode, ...extra]);
}

it("scrubs only old unlocked plaintext configs and checks without writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "scrub-runner-")); directories.push(root);
  const secret = `fake-${randomUUID()}`;
  const dead = await fixture(root, "dead", secret);
  const deadConfig = JSON.parse(await readFile(dead.configPath, "utf8"));
  deadConfig.agent.agents_sdk = { entry_agent: "a", agents: [{ id: "a", name: "A", instructions: "test",
    mcp_servers: [{ type: "stdio", command: "test", env: { KEY: secret } }] }] };
  deadConfig.mcpSecretRefs = [{ server: "previous", field: "headers", key: "old", env: "OLD" }];
  await writeFile(dead.configPath, JSON.stringify(deadConfig));
  const old = new Date(Date.now() - 180_000);
  await utimes(dead.configPath, old, old);
  const live = await fixture(root, "live", secret);
  const busy = await fixture(root, "busy", secret);
  const recent = await fixture(root, "recent", secret, false);
  const clean = await fixture(root, "clean", "");
  const liveLock = await RunnerWriterLock.acquire(live.lockPath);
  const busyLock = await RunnerWriterLock.acquire(runnerSessionMutationLockPath(busy.sessionDirectory));
  try {
    const before = await Promise.all([live, busy, recent, clean].map((p) => readFile(p.configPath)));
    const names = await readdir(root);
    const checked = await run(root, "--check");
    expect(checked.stdout.includes(secret)).toBe(false);
    expect(await readdir(root)).toEqual(names);
    expect(JSON.parse(checked.stdout)).toMatchObject({ configs: 5, heldLocks: 1, withPlaintextSecrets: 4, plaintextWithLiveRunner: 1, rewritten: 0 });
    const applied = await run(root, "--apply");
    expect(applied.stdout.includes(secret)).toBe(false);
    expect(JSON.parse(applied.stdout)).toMatchObject({ configs: 5, heldLocks: 1, rewritten: 1, skippedBusy: 1, skippedRecent: 1, claudeFilesRemoved: 1, claudeFiles: 4 });
    const scrubbed = await readFile(dead.configPath, "utf8");
    expect(scrubbed.includes(secret)).toBe(false);
    expect(JSON.parse(scrubbed).mcpSecretRefs).toHaveLength(3);
    expect(JSON.parse(scrubbed).mcpSecretRefs[0].env).toBe("OLD");
    await expect(readFile(join(dead.sessionDirectory, "claude-mcp-config-test.json"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const [i, p] of [live, busy, recent, clean].entries()) expect((await readFile(p.configPath)).equals(before[i]!)).toBe(true);
  } finally { await liveLock.release(); await busyLock.release(); }
});

it("refuses all writes when no runner lock is held", async () => {
  const root = await mkdtemp(join(tmpdir(), "scrub-runner-")); directories.push(root);
  const secret = `fake-${randomUUID()}`;
  const path = await fixture(root, "dead", secret);
  const before = await readFile(path.configPath);
  const claudePath = join(path.sessionDirectory, "claude-mcp-config-test.json");
  const beforeClaude = await readFile(claudePath);
  const rootEntries = await readdir(root);
  const sessionEntries = await readdir(path.sessionDirectory);
  const result = await run(root, "--apply").then(() => null, (error) => error);
  expect(result?.code).not.toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ heldLocks: 0 });
  expect((await readFile(path.configPath)).equals(before)).toBe(true);
  expect((await readFile(claudePath)).equals(beforeClaude)).toBe(true);
  expect(await readdir(root)).toEqual(rootEntries);
  expect(await readdir(path.sessionDirectory)).toEqual(sessionEntries);
  expect(`${result.stdout}${result.stderr}`.includes(secret)).toBe(false);
  const checked = await run(root, "--check");
  expect(JSON.parse(checked.stdout).heldLocks).toBe(0);
});

it("allows an explicit no-lock override to scrub a dead runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "scrub-runner-")); directories.push(root);
  const secret = `fake-${randomUUID()}`;
  const path = await fixture(root, "dead", secret);
  const result = await run(root, "--apply", ["--allow-no-held-lock"]);
  expect(JSON.parse(result.stdout)).toMatchObject({ heldLocks: 0, rewritten: 1, claudeFilesRemoved: 1 });
  expect((await readFile(path.configPath, "utf8")).includes(secret)).toBe(false);
  await expect(readFile(join(path.sessionDirectory, "claude-mcp-config-test.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(result.stdout.includes(secret)).toBe(false);
});

it("refuses the override when live pid evidence conflicts with free locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "scrub-runner-")); directories.push(root);
  const secret = `fake-${randomUUID()}`;
  const path = await fixture(root, "dead", secret);
  await writeFile(path.pidPath, String(process.pid));
  const before = await readFile(path.configPath);
  const result = await run(root, "--apply", ["--allow-no-held-lock"]).then(() => null, (error) => error);
  expect(result?.code).not.toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ livePids: 1 });
  expect(`${result?.stdout}${result?.stderr}`.includes(secret)).toBe(false);
  expect((await readFile(path.configPath)).equals(before)).toBe(true);
  await expect(readFile(join(path.sessionDirectory, "claude-mcp-config-test.json"))).resolves.toBeDefined();
});
