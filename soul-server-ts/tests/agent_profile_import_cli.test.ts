import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const EXPECTED_PORTRAIT_MAX_BYTES = 5 * 1024 * 1024;
const directories: string[] = [];
const testDirectory = dirname(fileURLToPath(import.meta.url));

afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("agent profile importer CLI", () => {
  it("performs no writes when any planned portrait exceeds 5MiB", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-profile-import-cli-"));
    directories.push(directory);
    const portraitPath = join(directory, "over-limit.png");
    const configPath = join(directory, "agents.yaml");
    const portrait = Buffer.alloc(EXPECTED_PORTRAIT_MAX_BYTES + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(portrait);
    await writeFile(portraitPath, portrait);
    await writeFile(configPath, [
      "agents:",
      "  - id: oversize-agent",
      "    name: Oversize Agent",
      "    backend: codex",
      `    workspace_dir: ${JSON.stringify(directory)}`,
      `    portrait_path: ${JSON.stringify(portraitPath)}`,
      "    aliases: []",
      "    atom_contexts: []",
      "",
    ].join("\n"));

    const requests: Array<{ method: string; url: string }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method ?? "", url: request.url ?? "" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ profiles: [] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("test server did not bind a TCP port");
      const result = await run(process.execPath, [
        resolve(testDirectory, "../node_modules/tsx/dist/cli.mjs"),
        resolve(testDirectory, "../scripts/import-agent-profiles.ts"),
        "--agents-config",
        configPath,
        "--orch-url",
        `http://127.0.0.1:${address.port}`,
        "--apply",
        "--approved-fingerprint",
        "unused-because-planning-must-fail",
      ]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("5MiB");
      expect(requests).toEqual([{ method: "GET", url: "/api/agent-profiles/runtime" }]);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      }));
    }
  }, 30_000);
});

async function run(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stderr }));
  });
}
