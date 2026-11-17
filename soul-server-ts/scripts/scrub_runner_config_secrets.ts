// Linux: corepack pnpm@10.32.1 -C /path/to/soul-server-ts runner-config:scrub-secrets --state-dir /path/to/runner-state --check
// Windows PowerShell: corepack pnpm@10.32.1 -C C:\soulstream\soul-server-ts runner-config:scrub-secrets --state-dir C:\soulstream\runner-state --check
// Without pnpm: node /path/to/soul-server-ts/node_modules/tsx/dist/cli.mjs /path/to/soul-server-ts/scripts/scrub_runner_config_secrets.ts --state-dir /path/to/runner-state --check
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { writeFileAtomically } from "../src/atomic_file_rename.js";
import { externalizeMcpSecrets } from "../src/runner/mcp_secret_refs.js";
import type { RunnerChildConfig } from "../src/runner/runner_child_config.js";
import { withRunnerSessionMutationLock } from "../src/runner/runner_session_mutation_lock.js";
import { inspectRunnerWriterLock, type RunnerWriterLockState } from "../src/runner/runner_writer_lock.js";

const { values } = parseArgs({ args: process.argv.slice(2).filter((arg) => arg !== "--"), options: {
  "state-dir": { type: "string" },
  "agents-config-path": { type: "string" },
  check: { type: "boolean" },
  apply: { type: "boolean" },
} });
if (values.check && values.apply) throw new Error("Choose --check or --apply");
const stateDirectory = values["state-dir"] ?? process.env.SOUL_RUNNER_STATE_DIR;
if (!stateDirectory) throw new Error("State directory is required");

type RawConfig = RunnerChildConfig & Record<string, unknown>;
async function readConfig(directory: string): Promise<RawConfig | undefined> {
  try { return JSON.parse(await readFile(join(directory, "runner-config.json"), "utf8")) as RawConfig; }
  catch { return undefined; }
}
async function lockState(directory: string, config?: RawConfig): Promise<RunnerWriterLockState> {
  try {
    const path = config?.paths?.lockPath;
    return await inspectRunnerWriterLock(typeof path === "string" && path ? path : join(directory, "runner.lock"));
  } catch { return { kind: "unavailable" }; }
}
async function hasLivePid(directory: string): Promise<boolean> {
  let pid: number;
  try { pid = Number((await readFile(join(directory, "runner.pid"), "utf8")).trim()); }
  catch { return false; }
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function claudeFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => /^claude-mcp-config-.*\.json$/.test(name));
}

async function run(): Promise<void> {
  const directories = (await readdir(stateDirectory!, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => join(stateDirectory!, entry.name));
  const entries = await Promise.all(directories.map(async (directory) => {
    const config = await readConfig(directory);
    return { directory, config, lock: await lockState(directory, config), files: await claudeFiles(directory) };
  }));
  if (values.apply && !entries.some((entry) => entry.lock.kind === "held")) {
    const livePids = (await Promise.all(entries.map((entry) => hasLivePid(entry.directory)))).filter(Boolean).length;
    if (livePids) {
      process.stdout.write(`${JSON.stringify({ livePids })}\n`);
      process.exitCode = 1;
      return;
    }
  }
  const counts = { configs: 0, withRefs: 0, withPlaintextSecrets: 0, plaintextWithLiveRunner: 0,
    rewritten: 0, skippedBusy: 0, skippedRecent: 0, claudeFiles: 0, claudeFilesRemoved: 0 };
  for (const entry of entries) {
    let files = entry.files;
    const config = entry.config;
    if (!config) { counts.claudeFiles += files.length; continue; }
    counts.configs++;
    if (config.mcpSecretRefs !== undefined) counts.withRefs++;
    let plaintext = externalizeMcpSecrets(config).refs.length > 0;
    const alive = entry.lock.kind !== "free";
    if (values.apply && plaintext && !alive) {
      try {
        await withRunnerSessionMutationLock(entry.directory, async () => {
          const latest = await readConfig(entry.directory);
          if (!latest || (await lockState(entry.directory, latest)).kind !== "free") return;
          const configPath = join(entry.directory, "runner-config.json");
          if (Date.now() - (await stat(configPath)).mtimeMs <= 120_000) { counts.skippedRecent++; return; }
          const converted = externalizeMcpSecrets(latest);
          if (!converted.refs.length) { plaintext = false; return; }
          await writeFileAtomically(configPath, JSON.stringify({
            ...converted.config, mcpSecretRefs: [...(latest.mcpSecretRefs ?? []), ...converted.refs],
          }));
          counts.rewritten++;
          plaintext = false;
          files = await claudeFiles(entry.directory);
          for (const file of files) await unlink(join(entry.directory, file));
          counts.claudeFilesRemoved += files.length;
          files = [];
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("runner writer lock already held:")) counts.skippedBusy++;
        else throw error;
      }
    }
    if (plaintext) { counts.withPlaintextSecrets++; if (alive) counts.plaintextWithLiveRunner++; }
    counts.claudeFiles += files.length;
  }
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

run().catch(() => {
  // Parser and I/O errors may contain configuration values or paths.
  process.stderr.write("Runner config secret scrub failed\n");
  process.exitCode = 1;
});
