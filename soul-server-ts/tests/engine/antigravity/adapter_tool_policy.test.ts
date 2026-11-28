import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { AntigravityEngineAdapter } from "../../../src/engine/antigravity/adapter.js";
import { makeTempDirSync } from "../../helpers/temp_dir.js";
import { UTONIUM_ALLOWED, UTONIUM_DENIED } from "./utonium_policy_fixture.js";

function fixture(options: Partial<ConstructorParameters<typeof AntigravityEngineAdapter>[0]> = {}) {
  const directory = makeTempDirSync("agy-policy-adapter-");
  const executable = join(directory, "fake-agy.mjs");
  writeFileSync(executable, `#!/usr/bin/env node
for await(const chunk of process.stdin) {}
console.log(JSON.stringify({event:'init',conversation_id:'fixture-conversation'}));
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'응답'}}));
`);
  chmodSync(executable, 0o700);
  const workspace = join(directory, "workspace");
  const agents = join(workspace, ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "eye.md"), "---\nname: eye\ndescription: 관찰과 검증\ntools: Read, Grep, Glob, Bash\n---\n눈의 본문입니다.\n");
  const engine = new AntigravityEngineAdapter({ workspaceDir: workspace, agentId: "utonium", sessionDirectory: join(directory, "state"),
    executablePath: executable, processEnv: process.env, profileWorkspaceDir: workspace, ...options }, pino({ level: "silent" }));
  return { directory, engine, overlay: join(directory, "state", "antigravity-workspace") };
}
async function collect(engine: AntigravityEngineAdapter, params: Parameters<AntigravityEngineAdapter["execute"]>[0]) {
  const events = []; for await (const event of engine.execute(params)) events.push(event); return events;
}
const input = { agentSessionId: "session-restricted", prompt: "요청", systemPrompt: "메인 지시", model: "normal" };

describe("Antigravity workspace policy lifecycle", () => {
  it("preserves instructions and refreshes the restricted policy on resume", async () => {
    const { engine, overlay } = fixture({ allowedTools: UTONIUM_ALLOWED, disallowedTools: UTONIUM_DENIED, claudePermissionMode: "dontAsk" });
    try {
      expect((await collect(engine, input)).find(event => event.type === "complete")).toBeDefined();
      const instructions = readFileSync(join(overlay, "instructions", "chunk-000000.txt"), "utf8");
      expect(instructions).toContain("메인 지시"); expect(instructions).toContain("관찰과 검증");
      expect((await collect(engine, { ...input, systemPrompt: undefined, resumeSessionId: "fixture-conversation" })).find(event => event.type === "complete")).toBeDefined();
      expect(readFileSync(join(overlay, "instructions", "chunk-000000.txt"), "utf8")).toBe(instructions);
      const policy = JSON.parse(readFileSync(join(overlay, "policy.json"), "utf8"));
      expect(policy.allowedTools).toContain("invoke_subagent");
      expect(policy.subagents).toEqual([expect.stringMatching(/-eye$/)]);
    } finally { await engine.close(); }
  });
  it("adds no PreToolUse hook when dontAsk has no allowed list", async () => {
    const { engine, overlay } = fixture({ claudePermissionMode: "dontAsk" });
    try {
      await collect(engine, input);
      const hooks = JSON.parse(readFileSync(join(overlay, ".agents", "hooks.json"), "utf8"));
      expect(hooks["soulstream-session"].SessionStart).toHaveLength(1);
      expect(hooks["soulstream-session"].PreToolUse).toBeUndefined();
    } finally { await engine.close(); }
  });
  it("uses turn parameters over adapter options", async () => {
    const { engine, overlay } = fixture({ allowedTools: ["Read"], claudePermissionMode: "dontAsk" });
    try {
      await collect(engine, { ...input, allowedTools: ["Write", "Edit"], disallowedTools: ["Edit"] });
      const policy = JSON.parse(readFileSync(join(overlay, "policy.json"), "utf8"));
      expect(policy.allowedTools).toEqual(["write_to_file", "finish"]);
    } finally { await engine.close(); }
  });
});
