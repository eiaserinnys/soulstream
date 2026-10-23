import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROXY_FLAG = "--antigravity-mcp-schema-proxy";

export const ANTIGRAVITY_MCP_PROXY_CONFIG_ENV = "SOULSTREAM_ANTIGRAVITY_MCP_UPSTREAM";

export interface AntigravityMcpProxyLaunch {
  command: string;
  args: string[];
}

/** Resolve a source or packaged runner entry without shell or PATH lookup. */
export function resolveAntigravityMcpProxyLaunch(moduleUrl: string, nodeExecutable: string): AntigravityMcpProxyLaunch {
  const modulePath = fileURLToPath(moduleUrl);
  if (extname(modulePath) === ".ts") {
    const runnerEntry = fileURLToPath(new URL("../../runner/runner_entry.ts", moduleUrl));
    const tsxEsm = pathToFileURL(createRequire(moduleUrl).resolve("tsx/esm")).href;
    return { command: nodeExecutable, args: ["--import", tsxEsm, runnerEntry, PROXY_FLAG] };
  }

  const moduleDirectory = dirname(modulePath);
  const runnerDirectory = basename(moduleDirectory) === "runner" || basename(modulePath) === "runner_entry.js"
    ? moduleDirectory
    : join(moduleDirectory, "runner");
  return { command: nodeExecutable, args: [join(runnerDirectory, "runner_entry.js"), PROXY_FLAG] };
}
