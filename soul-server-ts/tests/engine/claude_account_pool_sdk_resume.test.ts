import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeSdkClient } from "../../src/engine/claude_sdk_client.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Claude account pool SDK resume", () => {
  it("keeps the selected config dir through the installed SDK resume spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-account-pool-sdk-resume-"));
    roots.push(root);
    const configDir = join(root, "selected-profile");
    const sharedProjects = join(root, "shared-projects");
    mkdirSync(configDir);
    mkdirSync(sharedProjects);
    symlinkSync(sharedProjects, join(configDir, "projects"), "dir");
    const executablePath = join(root, "capture-claude");
    const capturePath = join(root, "spawn-env.json");
    writeFileSync(executablePath, [
      "#!/usr/bin/env node",
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const path = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.env.POOL_PROJECT_KEY, `${process.env.POOL_SESSION_ID}.jsonl`);',
      'let transcript = null; try { transcript = readFileSync(path, "utf8"); } catch {}',
      'writeFileSync(process.env.POOL_ENV_CAPTURE_FILE, JSON.stringify({',
      "  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,",
      "  transcript,",
      "}));",
      "process.exit(0);",
      "",
    ].join("\n"), { mode: 0o700 });
    chmodSync(executablePath, 0o700);

    const resumeSessionId = "550e8400-e29b-41d4-a716-446655440000";
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
          POOL_ENV_CAPTURE_FILE: capturePath,
          POOL_PROJECT_KEY: root.replace(/[^a-zA-Z0-9]/g, "-"),
          POOL_SESSION_ID: resumeSessionId,
        },
        trackChildExit: true,
      }, new AbortController().signal);
      try {
        for await (const _event of events) {
          // The stub CLI exits without a response; the SDK still completes its real spawn path.
        }
      } catch {
        // The stub executable does not implement the Claude stream protocol.
      }
      const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
        CLAUDE_CONFIG_DIR: string;
        transcript: string | null;
      };
      expect(capture.CLAUDE_CONFIG_DIR).toBe(configDir);
      // The DB copy is gone (#1075). Only the local JSONL remains, and none exists here.
      expect(capture.transcript).toBeNull();
    } finally {
      await client.close();
    }
  });
});
