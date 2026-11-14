import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import {
  materializeAntigravityRestrictedBundle,
  writeAntigravityRestrictedBundle,
} from "../../../src/engine/antigravity/restricted_bundle.js";
import { makeTempDirSync } from "../../helpers/temp_dir.js";
import { UTONIUM_ALLOWED, UTONIUM_DENIED } from "./utonium_policy_fixture.js";

const testHome = makeTempDirSync("agy-restricted-home-");
vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => testHome,
}));

const logger = { warn: vi.fn() };
const launch = { command: "/absolute/node", args: ["/absolute/runner.js", "--antigravity-mcp-gateway"] };
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

function profileWorkspace(withEye: boolean) {
  const workspace = makeTempDirSync("agy-profile-workspace-");
  if (withEye) {
    const directory = join(workspace, ".claude", "agents");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "eye.md"), [
      "---",
      "name: eye",
      "description: 관찰과 검증을 맡는 하위 에이전트",
      "tools: Read, Grep, Glob, Bash",
      "model: opus",
      "---",
      "눈의 본문입니다.",
      "",
    ].join("\n"));
  }
  return workspace;
}

function frontmatter(file: string) {
  return parse(readFileSync(file, "utf8").split("---\n")[1]!);
}

function body(file: string) {
  return readFileSync(file, "utf8").split("---\n")[2]!;
}

async function writeBundle(withEye = true) {
  const workspace = profileWorkspace(withEye);
  const directory = join(makeTempDirSync("agy-bundle-"), "antigravity-tool-policy");
  const bundle = await writeAntigravityRestrictedBundle({
    directory,
    agentId: "utonium",
    agentSessionId: "session-restricted",
    systemPrompt: "메인 지시",
    gatewayConfigPath: "/absolute/gateway.json",
    useMcp: false,
    mcpGatewayLaunch: launch,
    allowedTools: UTONIUM_ALLOWED,
    disallowedTools: UTONIUM_DENIED,
    profileWorkspaceDir: workspace,
    logger,
  });
  return { bundle, directory, agents: join(directory, "agents"), workspace };
}

describe("Antigravity restricted definition bundle", () => {
  it("writes the main definition, hook, policy, and a mapped eye subagent", async () => {
    const { bundle, directory, agents } = await writeBundle();
    const mainFile = join(agents, `${bundle.mainName}.md`);
    const main = frontmatter(mainFile);

    expect(main.tools).toEqual(mainTools);
    expect(main.mainAgent).toBe(true);
    expect(main.subagent).toBe(false);
    expect(main.hooks).toEqual([join(directory, "hooks.json")]);
    expect(body(mainFile)).toContain("## 하위 에이전트");
    expect(body(mainFile)).toContain("eye");

    const eyeFile = join(agents, `${bundle.mainName}-eye.md`);
    const eye = frontmatter(eyeFile);
    expect(eye.name).toBe(`${bundle.mainName}-eye`);
    expect(eye.description).toBe("관찰과 검증을 맡는 하위 에이전트");
    expect(eye.mainAgent).toBe(false);
    expect(eye.subagent).toBe(true);
    expect(eye.model).toBe("inherit");
    expect(eye.tools).toEqual(eyeTools);
    expect(body(eyeFile)).toContain("눈의 본문입니다.");

    expect(JSON.parse(readFileSync(join(directory, "policy.json"), "utf8"))).toMatchObject({
      mcp: { gatewayServer: "profile-utonium" },
    });
    const hooks = JSON.parse(readFileSync(join(directory, "hooks.json"), "utf8"));
    const hook = hooks["soulstream-tool-policy"].PreToolUse[0];
    expect(hook.matcher).toBe("*");
    expect(hook.hooks[0].timeout).toBe(10);
    expect(hook.hooks[0].command).toContain(join(directory, "tool-gate.cjs"));
    expect(hook.hooks[0].command).toContain(join(directory, "policy.json"));
    expect(statSync(join(directory, "policy.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "tool-gate.cjs")).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "hooks.json")).mode & 0o777).toBe(0o600);
    expect(statSync(mainFile).mode & 0o777).toBe(0o600);
    expect(statSync(eyeFile).mode & 0o777).toBe(0o600);
  });

  it("writes no subagent when the profile has no .claude/agents directory", async () => {
    const { bundle, agents } = await writeBundle(false);
    expect(readdirSync(agents)).toEqual([`${bundle.mainName}.md`]);
    expect(body(join(agents, `${bundle.mainName}.md`))).not.toContain("## 하위 에이전트");
  });

  it("materializes the same names and contents into the agy agents folder and removes them", async () => {
    const { bundle, agents } = await writeBundle();
    const installed = await materializeAntigravityRestrictedBundle(
      join(agents, ".."),
    );
    const agentsDirectory = join(testHome, ".gemini", "config", "agents");
    try {
      expect(installed.name).toBe(bundle.mainName);
      for (const file of readdirSync(agents)) {
        const target = join(agentsDirectory, file);
        expect(readFileSync(target, "utf8")).toBe(readFileSync(join(agents, file), "utf8"));
        expect(statSync(target).mode & 0o777).toBe(0o600);
      }
    } finally {
      await installed.remove();
    }
    for (const file of [`${bundle.mainName}.md`, `${bundle.mainName}-eye.md`]) {
      expect(existsSync(join(agentsDirectory, file))).toBe(false);
    }
  });
});
