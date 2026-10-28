import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
    const store = {
      append: vi.fn(async () => undefined),
      load: vi.fn(async () => [
        { type: "user", uuid: "legacy-user" },
        { type: "assistant", uuid: "legacy-reply" },
        { type: "user", uuid: "latest-user" },
      ] as never),
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
            POOL_PROJECT_KEY: root.replace(/[^a-zA-Z0-9]/g, "-"),
            POOL_SESSION_ID: resumeSessionId,
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
          transcript: string | null;
        };
      } finally {
        await client.close();
      }
    };

    const rawStoreCapturePath = join(root, "raw-store-spawn-env.json");
    const rawStoreEnv = await runResume(store, rawStoreCapturePath);
    expect(rawStoreEnv.CLAUDE_CONFIG_DIR).not.toBe(configDir);
    expect(rawStoreEnv.transcript?.trim().split("\n").map((line) => JSON.parse(line)))
      .toEqual(await store.load.mock.results[0]!.value);
    expect(store.load).toHaveBeenCalledOnce();
    rmSync(rawStoreEnv.CLAUDE_CONFIG_DIR, { recursive: true, force: true });

    store.load.mockClear();
    const poolStoreCapturePath = join(root, "pool-store-spawn-env.json");
    const poolStoreEnv = await runResume(
      useLocalClaudeAccountPoolResume(store as never, configDir),
      poolStoreCapturePath,
    );
    expect(poolStoreEnv.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(poolStoreEnv.transcript).toBe(rawStoreEnv.transcript);
    expect(store.load).toHaveBeenCalledOnce();
    expect(existsSync(join(sharedProjects, root.replace(/[^a-zA-Z0-9]/g, "-"), `${resumeSessionId}.jsonl`))).toBe(true);
    expect(store.append).not.toHaveBeenCalled();
  });

  it("restores newer DB transcripts and subagents while preserving newer local files", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-pool-materialize-"));
    roots.push(root);
    const configDir = join(root, "profile");
    const sharedProjects = join(root, "shared-projects");
    mkdirSync(configDir);
    mkdirSync(sharedProjects);
    symlinkSync(sharedProjects, join(configDir, "projects"), "dir");
    const key = { projectKey: "project", sessionId: "550e8400-e29b-41d4-a716-446655440000" };
    const transcriptPath = join(sharedProjects, key.projectKey, `${key.sessionId}.jsonl`);
    const subagentPath = join(sharedProjects, key.projectKey, key.sessionId, "subagents", "agent-a.jsonl");
    const entries = [
      { type: "user", uuid: "one" },
      { type: "assistant", uuid: "two" },
      { type: "user", uuid: "three" },
    ];
    const subagent = [{ type: "assistant", uuid: "sub-one" }];
    const store = {
      append: vi.fn(async () => undefined),
      load: vi.fn(async (loadedKey: typeof key & { subpath?: string }) =>
        loadedKey.subpath ? [...subagent, { type: "agent_metadata", agentType: "helper" }] : entries),
      listSubkeys: vi.fn(async () => ["subagents/agent-a"]),
    };
    const wrapped = useLocalClaudeAccountPoolResume(store as never, configDir);
    await expect(wrapped.load(key)).resolves.toBeNull();
    const parseLines = (path: string) => readFileSync(path, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    expect(parseLines(transcriptPath)).toEqual(entries);
    expect(parseLines(subagentPath)).toEqual(subagent);
    expect(JSON.parse(readFileSync(subagentPath.replace(/\.jsonl$/, ".meta.json"), "utf8")))
      .toEqual({ agentType: "helper" });
    const equalInode = statSync(transcriptPath).ino;
    await wrapped.load(key);
    expect(statSync(transcriptPath).ino).toBe(equalInode);

    writeFileSync(transcriptPath, `${JSON.stringify(entries[0])}\n`);
    await wrapped.load(key);
    expect(parseLines(transcriptPath)).toEqual(entries);

    const newer = [...entries, { type: "assistant", uuid: "local-newer" }];
    writeFileSync(transcriptPath, `${newer.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const newerInode = statSync(transcriptPath).ino;
    await wrapped.load(key);
    expect(parseLines(transcriptPath)).toEqual(newer);
    expect(statSync(transcriptPath).ino).toBe(newerInode);
    const shorterButNewer = [{ type: "user", uuid: "local-newer", timestamp: "2026-10-28T04:00:00Z" }];
    writeFileSync(transcriptPath, `${JSON.stringify(shorterButNewer[0])}\n`);
    store.load.mockImplementation(async (loadedKey) => loadedKey.subpath
      ? [...subagent, { type: "agent_metadata", agentType: "helper" }]
      : entries.map((entry) => ({ ...entry, timestamp: "2026-10-27T04:00:00Z" })));
    const shorterNewerInode = statSync(transcriptPath).ino;
    await wrapped.load(key);
    expect(parseLines(transcriptPath)).toEqual(shorterButNewer);
    expect(statSync(transcriptPath).ino).toBe(shorterNewerInode);
    expect(store.load).toHaveBeenCalledWith(key);
    expect(store.load).toHaveBeenCalledWith({ ...key, subpath: "subagents/agent-a" });
  });

  it("serializes materialization for the same session across shared profiles", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-pool-concurrent-"));
    roots.push(root);
    const projects = join(root, "shared-projects");
    mkdirSync(projects);
    const profiles = [join(root, "a"), join(root, "b")];
    for (const profile of profiles) {
      mkdirSync(profile);
      symlinkSync(projects, join(profile, "projects"), "dir");
    }
    const key = { projectKey: "project", sessionId: "550e8400-e29b-41d4-a716-446655440000" };
    let finishFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { finishFirst = resolve; });
    const load = vi.fn()
      .mockImplementationOnce(async () => { await firstBlocked; return [{ type: "user", uuid: "one" }]; })
      .mockImplementationOnce(async () => [
        { type: "user", uuid: "one" }, { type: "assistant", uuid: "two" },
      ]);
    const store = { load, append: vi.fn() };
    const first = useLocalClaudeAccountPoolResume(store as never, profiles[0]!).load(key);
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      const second = useLocalClaudeAccountPoolResume(store as never, profiles[1]!).load(key);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(load).toHaveBeenCalledTimes(1);
      finishFirst();
      await Promise.all([first, second]);
      const contents = readFileSync(join(projects, key.projectKey, `${key.sessionId}.jsonl`), "utf8");
      expect(contents.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        { type: "user", uuid: "one" }, { type: "assistant", uuid: "two" },
      ]);
    } finally {
      finishFirst();
      await first;
    }
  });
});
