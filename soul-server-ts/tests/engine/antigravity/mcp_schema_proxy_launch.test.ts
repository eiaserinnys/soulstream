import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAntigravityMcpProxyLaunch } from "../../../src/engine/antigravity/mcp_schema_proxy_launch.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
const packageRequire = createRequire(resolve(packageRoot, "package.json"));
const sourceAdapterPath = resolve(packageRoot, "src/engine/antigravity/adapter.ts");
const sourceRunnerPath = resolve(packageRoot, "src/runner/runner_entry.ts");
const tsxEsmUrl = pathToFileURL(packageRequire.resolve("tsx/esm")).href;

describe("resolveAntigravityMcpProxyLaunch", () => {
  it("launches the source runner through the absolute tsx ESM loader", () => {
    const launch = resolveAntigravityMcpProxyLaunch(pathToFileURL(sourceAdapterPath).href, "/usr/bin/node");

    expect(launch).toEqual({
      command: "/usr/bin/node",
      args: ["--import", tsxEsmUrl, sourceRunnerPath, "--antigravity-mcp-schema-proxy"],
    });
    expect(launch.args[1]).toBe(tsxEsmUrl);
    expect(launch.args[1]).toMatch(/^file:\/\//);
    expect(launch.args[2]).toMatch(/^\//);
  });

  it.each([
    ["host main", "file:///srv/soul-server-ts/dist/main.js", "/srv/soul-server-ts/dist/runner/runner_entry.js"],
    ["host root chunk", "file:///srv/soul-server-ts/dist/chunk-DISTROOT.js", "/srv/soul-server-ts/dist/runner/runner_entry.js"],
    ["runner snapshot", "file:///srv/releases/sha256-abcd/runner_entry.js", "/srv/releases/sha256-abcd/runner_entry.js"],
    ["runner directory", "file:///srv/releases/sha256-abcd/runner/runner_entry.js", "/srv/releases/sha256-abcd/runner/runner_entry.js"],
  ])("uses the packaged runner in the %s environment", (_name, moduleUrl, runnerPath) => {
    expect(resolveAntigravityMcpProxyLaunch(moduleUrl, "/usr/bin/node")).toEqual({
      command: "/usr/bin/node",
      args: [runnerPath, "--antigravity-mcp-schema-proxy"],
    });
  });
});
