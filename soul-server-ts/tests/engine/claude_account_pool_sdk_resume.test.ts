import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeSdkClient } from "../../src/engine/claude_sdk_client.js";
import { useLocalClaudeAccountPoolResume } from "../../src/engine/claude_account_pool.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Claude account pool SDK resume", () => {
  it("keeps the selected config dir through the installed SDK resume plus sessionStore spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-account-pool-sdk-resume-"));
    roots.push(root);
    const configDir = join(root, "selected-profile");
    const executablePath = join(root, "capture-claude");
    const capturePath = join(root, "spawn-env.json");
    writeFileSync(executablePath, [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.env.POOL_ENV_CAPTURE_FILE, JSON.stringify({',
      "  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,",
      "}));",
      "process.exit(0);",
      "",
    ].join("\n"), { mode: 0o700 });
    chmodSync(executablePath, 0o700);

    const resumeSessionId = "550e8400-e29b-41d4-a716-446655440000";
    const store = {
      append: vi.fn(async () => undefined),
      load: vi.fn(async () => [{ type: "assistant", uuid: "stored-entry" }] as never),
      listSessions: vi.fn(async () => []),
      listSubkeys: vi.fn(async () => []),
    };
    const runResume = async (sessionStore: unknown, destination: string) => {
      const client = new ClaudeSdkClient({ postResultDrainMs: 10 }, pino({ level: "silent" }));
      try {
        const events = client.run({
          prompt: "resume this session",
          workspaceDir: root,
          resumeSessionId,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            CLAUDE_CONFIG_DIR: configDir,
            CLAUDE_CODE_EXECPATH: executablePath,
            POOL_ENV_CAPTURE_FILE: destination,
          },
          sessionStore: sessionStore as never,
          sessionStoreFlush: "eager",
          trackChildExit: true,
        }, new AbortController().signal);
        try {
          for await (const _event of events) {
            // The stub CLI exits without a response; the SDK still completes its real spawn path.
          }
        } catch {
          // The stub executable does not implement the Claude stream protocol.
        }
        return JSON.parse(readFileSync(destination, "utf8")) as {
          CLAUDE_CONFIG_DIR: string;
        };
      } finally {
        await client.close();
      }
    };

    const rawStoreCapturePath = join(root, "raw-store-spawn-env.json");
    const rawStoreEnv = await runResume(store, rawStoreCapturePath);
    expect(rawStoreEnv.CLAUDE_CONFIG_DIR).not.toBe(configDir);
    expect(store.load).toHaveBeenCalledOnce();
    rmSync(rawStoreEnv.CLAUDE_CONFIG_DIR, { recursive: true, force: true });

    store.load.mockClear();
    const poolStoreCapturePath = join(root, "pool-store-spawn-env.json");
    const poolStoreEnv = await runResume(
      useLocalClaudeAccountPoolResume(store as never),
      poolStoreCapturePath,
    );
    expect(poolStoreEnv.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(store.load).not.toHaveBeenCalled();
    expect(store.append).not.toHaveBeenCalled();
  });
});
