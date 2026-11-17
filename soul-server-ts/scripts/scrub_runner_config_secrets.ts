// Linux: corepack pnpm -C soul-server-ts runner-config:scrub-secrets -- --state-dir /path/to/runner-state --agents-config-path /path/to/agents.yaml --check
// Windows (PowerShell): corepack pnpm -C soul-server-ts runner-config:scrub-secrets -- --state-dir C:\soulstream\runner-state --agents-config-path C:\soulstream\config\agents.yaml --check
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { writeFileAtomically } from "../src/atomic_file_rename.js";
import { McpConfigService } from "../src/mcp_config_service.js";
import { parseRunnerChildConfig } from "../src/runner/runner_child_config.js";
import { externalizeMcpSecrets, type McpSecretRef } from "../src/runner/mcp_secret_refs.js";

const { values } = parseArgs({ options: {
  "state-dir": { type: "string" },
  "agents-config-path": { type: "string" },
  check: { type: "boolean" },
  apply: { type: "boolean" },
} });
if (values.check && values.apply) throw new Error("Choose --check or --apply");
const stateDirectory = values["state-dir"] ?? process.env.SOUL_RUNNER_STATE_DIR;
const agentsConfigPath = values["agents-config-path"] ?? process.env.AGENTS_CONFIG_PATH;
if (!stateDirectory || !agentsConfigPath) throw new Error("State directory and agents config path are required");

async function runnerMayBeAlive(directory: string): Promise<boolean> {
  let pid: number;
  try {
    pid = Number((await readFile(join(directory, "runner.pid"), "utf8")).trim());
  } catch {
    return true;
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function run(): Promise<void> {
  const declarations = new McpConfigService({ agentsConfigPath: agentsConfigPath! }).listSecretRefs();
  const counts = { configs: 0, withRefs: 0, withPlaintextSecrets: 0, plaintextWithLiveRunner: 0, claudeFiles: 0 };
  for (const entry of await readdir(stateDirectory!, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(stateDirectory!, entry.name);
    const configPath = join(directory, "runner-config.json");
    let claudeFiles = (await readdir(directory)).filter((name) => /^claude-mcp-config-.*\.json$/.test(name));
    let before;
    try { before = await stat(configPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        counts.claudeFiles += claudeFiles.length;
        continue;
      }
      throw error;
    }
    const raw: Record<string, unknown> = JSON.parse(await readFile(configPath, "utf8"));
    const config = parseRunnerChildConfig(raw);
    const converted = externalizeMcpSecrets(config.resolvedMcpServers ?? [], declarations, process.env);
    const alive = await runnerMayBeAlive(directory);
    const refs = config.mcpSecretRefs;
    let plaintextCount = converted.refs.length;
    if (values.apply && !alive) {
      const latest = await stat(configPath);
      if (latest.mtimeMs === before.mtimeMs && !(await runnerMayBeAlive(directory))) {
        if (plaintextCount > 0) {
          const updated = {
            ...raw,
            ...(config.resolvedMcpServers ? { resolvedMcpServers: converted.servers } : {}),
            legacyMcpSecretRefs: mergeRefs(config.legacyMcpSecretRefs ?? [], converted.refs),
          };
          await writeFileAtomically(configPath, JSON.stringify(updated));
          plaintextCount = 0;
        }
        for (const file of claudeFiles) await unlink(join(directory, file));
        claudeFiles = [];
      }
    }
    counts.configs++;
    if (refs !== undefined) counts.withRefs++;
    if (plaintextCount) {
      counts.withPlaintextSecrets++;
      if (alive) counts.plaintextWithLiveRunner++;
    }
    counts.claudeFiles += claudeFiles.length;
  }
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

function mergeRefs(existing: McpSecretRef[], added: McpSecretRef[]): McpSecretRef[] {
  return [...existing, ...added.filter((ref) => !existing.some((old) =>
    old.server === ref.server && old.field === ref.field && old.key === ref.key))];
}

run().catch(() => {
  // Do not print parser errors: they may contain input values.
  process.stderr.write("Runner config secret scrub failed\n");
  process.exitCode = 1;
});
