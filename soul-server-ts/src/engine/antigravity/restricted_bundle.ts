import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ResolvedMcpServer } from "../../mcp_config_service.js";
import {
  antigravityAgentDefinitionText,
  antigravityDefinitionName,
  antigravitySubagentDefinitionText,
  antigravitySubagentSection,
  readClaudeSubagentDefinitions,
} from "./agent_definition.js";
import type { AntigravityMcpProxyLaunch } from "./mcp_schema_proxy_launch.js";
import {
  ANTIGRAVITY_TOOL_GATE_SOURCE,
  antigravitySubagentTools,
  computeAntigravityToolPolicy,
} from "./tool_policy.js";

/**
 * 제한 모드(dontAsk + allowedTools) 세션의 정의·정책 묶음.
 * 재개와 프로세스 재시작에도 남도록 세션 상태 폴더에 원문을 0600으로 두고,
 * 매 턴 agy 에이전트 폴더로 같은 이름·같은 내용을 다시 쓴다.
 */

const HOOK_NAME = "soulstream-tool-policy";
const DEFINITION_FILE = /^soulstream-[0-9a-f]{24}\.md$/;

export interface AntigravityRestrictedBundleOptions {
  directory: string;
  agentId: string;
  agentSessionId: string;
  systemPrompt: string;
  gatewayConfigPath: string;
  resolvedMcpServers?: ResolvedMcpServer[];
  internalMcpUrl?: string;
  useMcp?: boolean;
  mcpGatewayLaunch?: AntigravityMcpProxyLaunch;
  allowedTools: readonly string[];
  disallowedTools?: readonly string[];
  profileWorkspaceDir: string;
  logger: Pick<Logger, "warn">;
}

export interface AntigravityRestrictedBundle {
  directory: string;
  mainName: string;
  definitionNames: string[];
}

export async function writeAntigravityRestrictedBundle(
  options: AntigravityRestrictedBundleOptions,
): Promise<AntigravityRestrictedBundle> {
  const policy = computeAntigravityToolPolicy({
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    agentId: options.agentId,
  });
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const agentsDirectory = join(options.directory, "agents");
  await mkdir(agentsDirectory, { recursive: true, mode: 0o700 });
  const policyPath = join(options.directory, "policy.json");
  const gatePath = join(options.directory, "tool-gate.cjs");
  const hooksPath = join(options.directory, "hooks.json");

  await writePrivate(policyPath, JSON.stringify(policy.gate, null, 2));
  await writePrivate(gatePath, ANTIGRAVITY_TOOL_GATE_SOURCE);
  await writePrivate(hooksPath, JSON.stringify({
    [HOOK_NAME]: {
      PreToolUse: [{
        matcher: "*",
        hooks: [{
          type: "command",
          command: [process.execPath, gatePath, policyPath].map(path => JSON.stringify(path)).join(" "),
          timeout: 10,
        }],
      }],
    },
  }, null, 2));

  // 정의 tools에 invoke_subagent가 없으면 하위 정의를 만들지 않는다(설계 §3).
  const subagents = policy.definitionTools.includes("invoke_subagent")
    ? await readClaudeSubagentDefinitions(options.profileWorkspaceDir, options.logger)
    : [];
  const mainName = antigravityDefinitionName(options.agentSessionId);
  const listings = subagents.map(subagent => ({
    originalName: subagent.name,
    invokeName: `${mainName}-${subagent.name}`,
    description: subagent.description,
  }));
  const main = antigravityAgentDefinitionText({
    agentId: options.agentId,
    agentSessionId: options.agentSessionId,
    systemPrompt: options.systemPrompt,
    gatewayConfigPath: options.gatewayConfigPath,
    resolvedMcpServers: options.resolvedMcpServers,
    internalMcpUrl: options.internalMcpUrl,
    useMcp: options.useMcp,
    mcpGatewayLaunch: options.mcpGatewayLaunch,
    logger: options.logger,
    tools: policy.definitionTools,
    hooks: [hooksPath],
    bodySuffix: antigravitySubagentSection(listings),
  });

  await writePrivate(join(agentsDirectory, `${main.name}.md`), main.text);
  const definitionNames = [main.name];
  for (const [index, subagent] of subagents.entries()) {
    const listing = listings[index]!;
    const text = antigravitySubagentDefinitionText({
      name: listing.invokeName,
      description: subagent.description,
      tools: antigravitySubagentTools(subagent.tools),
      body: subagent.body,
    });
    await writePrivate(join(agentsDirectory, `${listing.invokeName}.md`), text);
    definitionNames.push(listing.invokeName);
  }
  return { directory: options.directory, mainName: main.name, definitionNames };
}

/** 보존한 원문을 agy 에이전트 폴더에 같은 이름·같은 내용으로 쓴다. 실패 시 이미 쓴 파일을 지운다. */
export async function materializeAntigravityRestrictedBundle(
  directory: string,
): Promise<{ name: string; remove: () => Promise<void> }> {
  const originalsDirectory = join(directory, "agents");
  let files: string[];
  try {
    files = (await readdir(originalsDirectory)).filter(name => name.endsWith(".md")).sort();
  } catch {
    throw new Error(`Antigravity restricted tool policy bundle is missing: ${directory}`);
  }
  const mainFile = files.find(file => DEFINITION_FILE.test(file));
  if (!mainFile) {
    throw new Error(`Antigravity restricted tool policy bundle has no main definition: ${directory}`);
  }
  const targetDirectory = join(homedir(), ".gemini", "config", "agents");
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const installed: string[] = [];
  try {
    for (const file of files) {
      const target = join(targetDirectory, file);
      await writeFile(target, await readFile(join(originalsDirectory, file), "utf8"), { mode: 0o600 });
      await chmod(target, 0o600);
      installed.push(target);
    }
  } catch (error) {
    await Promise.all(installed.map(target => rm(target, { force: true })));
    throw error;
  }
  return {
    name: mainFile.replace(/\.md$/, ""),
    remove: async () => {
      await Promise.all(files.map(file => rm(join(targetDirectory, file), { force: true })));
    },
  };
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}
