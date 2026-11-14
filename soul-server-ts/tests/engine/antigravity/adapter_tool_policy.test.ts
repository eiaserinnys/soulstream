import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { AntigravityEngineAdapter } from "../../../src/engine/antigravity/adapter.js";
import { ANTIGRAVITY_AGENT_TOOLS } from "../../../src/engine/antigravity/agent_tools.js";
import { makeTempDirSync } from "../../helpers/temp_dir.js";
import { UTONIUM_ALLOWED, UTONIUM_DENIED } from "./utonium_policy_fixture.js";

const testHome = makeTempDirSync("agy-policy-adapter-home-");
vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => testHome,
}));

const agentsDirectory = join(testHome, ".gemini", "config", "agents");
const mainTools = [
  "view_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "run_command",
  "invoke_subagent",
  "wait",
  "send_message",
  "finish",
];
const eyeTools = [
  "view_file",
  "run_command",
  "find_by_name",
  "list_dir",
  "grep_search",
  "send_message",
  "finish",
];

function fixture(options: Partial<ConstructorParameters<typeof AntigravityEngineAdapter>[0]> = {}) {
  const directory = makeTempDirSync("agy-policy-adapter-");
  const executable = join(directory, "fake-agy.mjs");
  writeFileSync(executable, `#!/usr/bin/env node
let input=''; for await(const chunk of process.stdin) input+=chunk;
const args=process.argv.slice(2);
const value=(key)=>args[args.indexOf(key)+1];
const id=args.includes('--conversation')?value('--conversation'):'fixture-conversation';
const emit=(x)=>console.log(JSON.stringify(x));
emit({event:'init',conversation_id:id,init:{model:value('--model')}});
emit({event:'step_update',step_update:{conversation_id:id,step_index:0,state:'DONE',step_type:'agent_response',text_delta:'응답',usage:{input_tokens:1,output_tokens:1}}});
emit({event:'result',result:{status:'SUCCESS',response:'응답'}});
setTimeout(()=>process.exit(0),20);
`);
  chmodSync(executable, 0o700);
  const workspace = join(directory, "workspace");
  const agents = join(workspace, ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "eye.md"), [
    "---",
    "name: eye",
    "description: 관찰과 검증을 맡는 하위 에이전트",
    "tools: Read, Grep, Glob, Bash",
    "model: opus",
    "---",
    "눈의 본문입니다.",
    "",
  ].join("\n"));
  const engine = new AntigravityEngineAdapter({
    workspaceDir: workspace,
    agentId: "utonium",
    sessionDirectory: join(directory, "state"),
    executablePath: executable,
    processEnv: { ...process.env },
    profileWorkspaceDir: workspace,
    ...options,
  }, pino({ level: "silent" }));
  return { directory, engine };
}

function soulstreamDefinitions() {
  try {
    return readdirSync(agentsDirectory).filter(name => name.startsWith("soulstream-")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function frontmatter(file: string) {
  return parse(readFileSync(file, "utf8").split("---\n")[1]!);
}

function frontmatterText(text: string) {
  return parse(text.split("---\n")[1]!);
}

async function collect(
  engine: AntigravityEngineAdapter,
  params: Parameters<AntigravityEngineAdapter["execute"]>[0],
  onSession?: () => void,
) {
  const events = [];
  for await (const event of engine.execute(params)) {
    if (event.type === "session") onSession?.();
    events.push(event);
  }
  return events;
}

describe("Antigravity restricted definition lifecycle", () => {
  it("writes the restricted main and subagent definitions on new and resumed turns and removes them at turn end", async () => {
    const { engine } = fixture({
      allowedTools: UTONIUM_ALLOWED,
      disallowedTools: UTONIUM_DENIED,
      claudePermissionMode: "dontAsk",
    });
    const input = { agentSessionId: "session-restricted", prompt: "요청", systemPrompt: "메인 지시", model: "normal" };
    let firstFiles: string[] = [];
    let firstContents: Record<string, string> = {};
    try {
      const first = await collect(engine, input, () => {
        firstFiles = soulstreamDefinitions();
        firstContents = Object.fromEntries(firstFiles.map(name => [
          name, readFileSync(join(agentsDirectory, name), "utf8"),
        ]));
      });

      expect(first.find(event => event.type === "complete")).toBeDefined();
      expect(firstFiles).toHaveLength(2);
      const mainFile = firstFiles.find(name => !name.includes("-eye"))!;
      const mainName = mainFile.replace(/\.md$/, "");
      expect(firstFiles).toContain(`${mainName}-eye.md`);
      const main = frontmatterText(firstContents[mainFile]!);
      expect(main.tools).toEqual(mainTools);
      expect(main.hooks).toHaveLength(1);
      expect(main.hooks[0]).toContain("hooks.json");
      const eye = frontmatterText(firstContents[`${mainName}-eye.md`]!);
      expect(eye.name).toBe(`${mainName}-eye`);
      expect(eye.subagent).toBe(true);
      expect(eye.model).toBe("inherit");
      expect(eye.tools).toEqual(eyeTools);
      expect(soulstreamDefinitions()).toEqual([]);

      let resumedFiles: string[] = [];
      const resumedContents: Record<string, string> = {};
      const resumed = await collect(
        engine,
        { agentSessionId: "session-restricted", prompt: "다음", model: "normal", resumeSessionId: "fixture-conversation" },
        () => {
          resumedFiles = soulstreamDefinitions();
          for (const name of resumedFiles) {
            resumedContents[name] = readFileSync(join(agentsDirectory, name), "utf8");
          }
        },
      );

      expect(resumed.find(event => event.type === "complete")).toBeDefined();
      expect(resumedFiles).toEqual(firstFiles);
      expect(resumedContents).toEqual(firstContents);
      expect(soulstreamDefinitions()).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it("keeps today's behavior when dontAsk has no allowed list and on other modes", async () => {
    const { engine } = fixture({ claudePermissionMode: "dontAsk" });
    const input = { agentSessionId: "session-default", prompt: "요청", systemPrompt: "메인 지시", model: "normal" };
    try {
      const first = await collect(engine, input, () => {
        const files = soulstreamDefinitions();
        expect(files).toHaveLength(1);
        const main = frontmatter(join(agentsDirectory, files[0]!));
        expect(main.tools).toEqual([...ANTIGRAVITY_AGENT_TOOLS]);
        expect(main.hooks).toBeUndefined();
      });
      expect(first.find(event => event.type === "complete")).toBeDefined();
      expect(soulstreamDefinitions()).toEqual([]);

      await collect(engine, { ...input, prompt: "다음", resumeSessionId: "fixture-conversation" }, () => {
        expect(soulstreamDefinitions()).toEqual([]);
      });
      expect(soulstreamDefinitions()).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it("uses turn parameters over adapter options", async () => {
    const { engine } = fixture({
      allowedTools: ["Read"],
      claudePermissionMode: "dontAsk",
    });
    try {
      await collect(engine, {
        agentSessionId: "session-params",
        prompt: "요청",
        systemPrompt: "메인 지시",
        model: "normal",
        allowedTools: ["Write", "Edit"],
        disallowedTools: ["Edit"],
      }, () => {
        const files = soulstreamDefinitions();
        expect(files).toHaveLength(1);
        const main = frontmatter(join(agentsDirectory, files[0]!));
        expect(main.tools).toEqual(["write_to_file", "finish"]);
      });
    } finally {
      await engine.close();
    }
  });
});
