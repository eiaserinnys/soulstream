/** Real agy restricted tool policy checks. Run ONLY with a mktemp -d root and an outer timeout 180. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import pino from "pino";
import { AntigravityEngineAdapter } from "../../src/engine/antigravity/adapter.js";
import { resolveAntigravityCliPath } from "@soulstream/executable-path";
import type { EngineExecuteParams, SSEEventPayload } from "../../src/engine/protocol.js";

const root = process.argv[2];
assert(root && resolve(root).startsWith("/tmp/"), "Pass a mktemp -d root under /tmp");
assert.equal((await readdir(root)).length, 0, "Scratch root must start empty");
const executablePath = resolveAntigravityCliPath(null, process.env)?.path;
assert(executablePath, "agy must be installed");

const workspace = join(root, "workspace");
const unit = join(workspace, "unit");
const state = join(root, "state");
await Promise.all([workspace, unit, state].map(async dir => await mkdir(dir, { mode: 0o700 })));
await writeFile(join(workspace, "marker.txt"), "EYE_OK\n", { mode: 0o600 });
await mkdir(join(workspace, ".claude", "agents"), { recursive: true, mode: 0o700 });
await writeFile(join(workspace, ".claude", "agents", "eye.md"), [
  "---",
  "name: eye",
  "description: 파일을 읽고 근거를 보고하는 하위 에이전트",
  "tools: Read, Grep, Glob, Bash",
  "model: opus",
  "---",
  "당신은 눈이다. 요청한 파일을 실제로 읽고 본문 내용을 그대로 보고한다.",
  "",
].join("\n"), { mode: 0o600 });

const agentSessionId = `agy-restricted-${Date.now()}`;
const mainName = `soulstream-${createHash("sha256").update(agentSessionId).digest("hex").slice(0, 24)}`;
const agentsDirectory = join(homedir(), ".gemini", "config", "agents");
const overlay = join(state, "antigravity-workspace");
const eyeTools = ["view_file", "find_by_name", "list_dir", "grep_search", "run_command", "send_message", "finish"];

async function definitionNames() {
  try { return (await readdir(agentsDirectory)).filter(name => name.startsWith(mainName)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function absent(path: string) {
  await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}
async function definitionEvidence(action: () => Promise<void>) {
  assert.deepEqual(await definitionNames(), []);
  await absent(join(overlay, ".agents", "agents"));
  const rule = await readFile(join(overlay, ".agents", "rules", "session-instructions.md"), "utf8");
  assert(rule.includes('TypeName "research"'));
  assert(rule.includes("eye"));
  const eyeFile = join(overlay, "subagent-instructions", "eye.txt");
  assert.equal((await stat(eyeFile)).mode & 0o777, 0o600);
  assert((await readFile(eyeFile, "utf8")).includes("당신은 눈이다"));
  const policy = JSON.parse(await readFile(join(overlay, "policy.json"), "utf8"));
  assert.deepEqual(policy.subagents, ["eye"]);
  assert.deepEqual([...policy.subagentTools].sort(), [...eyeTools].sort());
  await action();
}

async function run(params: EngineExecuteParams, onSession?: () => Promise<void>): Promise<SSEEventPayload[]> {
  const events: SSEEventPayload[] = [];
  for await (const event of engine.execute(params)) {
    if (event.type === "error") throw new Error(String(event.message));
    events.push(event);
    if (event.type === "session") await onSession?.();
  }
  return events;
}
function text(events: SSEEventPayload[]) {
  return events.filter(event => event.type === "assistant_message").map(event => event.content).join("\n");
}
function toolNames(events: SSEEventPayload[]) {
  const names = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_start" && typeof event.tool_name === "string") names.add(event.tool_name);
  }
  return names;
}

const engine = new AntigravityEngineAdapter({
  workspaceDir: workspace,
  agentId: "utonium-lab",
  sessionDirectory: state,
  executablePath,
  processEnv: process.env,
  profileWorkspaceDir: workspace,
  allowedTools: [
    "Read",
    `Write(//${unit}/**)`,
    "Bash(python3:*)",
    "Agent",
    "SendMessage",
    "Glob",
    "Grep",
  ],
  disallowedTools: ["Edit"],
  claudePermissionMode: "dontAsk",
}, pino({ level: "silent" }));

const base = { agentSessionId, model: "gemini-3.8-flash", reasoningEffort: "low" as const, useMcp: false };
const systemPrompt = `당신은 제한 모드 시험용 에이전트다. 한글로 답하고 실제 도구 결과만 근거로 삼아라.\n`;
const firstPrompt = [
  `write_file(또는 write_to_file)로 ${unit}/inside.txt에 INSIDE_OK를 써라.`,
  `그다음 write_file(또는 write_to_file)로 ${workspace}/outside.txt에 OUTSIDE_OK를 쓰려고 시도하라. 거부되면 재시도하지 말고 넘어가라.`,
  `run_command로 python3 -c "print('ALLOWED_OK')"를 실행하라.`,
  `그다음 run_command로 rm -rf ${unit}/inside.txt 를 시도하라. 거부되면 재시도하지 말고 넘어가라.`,
  `본문 '하위 에이전트' 절에 적힌 눈 에이전트를 invoke_subagent로 불러 ${workspace}/marker.txt를 읽고 본문을 그대로 보고하게 하라.`,
  `마지막에 수행 결과를 한글로 요약하라.`,
].join("\n");

let firstContents: Record<string, string> = {};
try {
  await absent(join(agentsDirectory, `${mainName}.md`));
  const first = await run({ ...base, systemPrompt, prompt: firstPrompt }, async () => {
    await definitionEvidence(async () => {
      firstContents = Object.fromEntries(await Promise.all(["policy.json", "subagent-instructions/eye.txt", ".agents/rules/session-instructions.md"].map(async name =>
        [name, await readFile(join(overlay, name), "utf8")] as const)));
    });
  });
  assert((await readFile(join(unit, "inside.txt"), "utf8")).includes("INSIDE_OK"));
  await absent(join(workspace, "outside.txt"));
  assert(text(first).includes("ALLOWED_OK"));
  assert(text(first).includes("EYE_OK"));
  const firstTools = toolNames(first);
  assert(firstTools.has("write_file") || firstTools.has("write_to_file"));
  assert(firstTools.has("run_command"));
  assert.deepEqual(await definitionNames(), []);
  console.log(JSON.stringify({ check: "restricted-first-turn", passed: true, tools: [...firstTools] }));

  const resumed = await run({ ...base, systemPrompt: undefined, prompt: "write_file(또는 write_to_file)로 " + unit + "/resumed.txt에 RESUMED_OK를 쓰고, run_command로 python3 -c \"print('RESUME_OK')\"를 실행하라. 끝나면 한글로 답하라.", resumeSessionId: first.find(event => event.type === "session")?.session_id as string }, async () => {
    await definitionEvidence(async () => {
      for (const [name, content] of Object.entries(firstContents)) {
        assert.equal(await readFile(join(overlay, name), "utf8"), content);
      }
    });
  });
  assert((await readFile(join(unit, "resumed.txt"), "utf8")).includes("RESUMED_OK"));
  assert(text(resumed).includes("RESUME_OK"));
  assert.deepEqual(await definitionNames(), []);
  console.log(JSON.stringify({ check: "restricted-resume-rewrite", passed: true }));
} finally {
  await engine.close();
}
console.log(JSON.stringify({ check: "antigravity-restricted-policy", passed: true, agentSessionId }));
