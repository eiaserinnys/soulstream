import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  antigravityDefinitionName, antigravityMcpServers, antigravitySubagentDefinitionText,
  antigravitySubagentSection, readClaudeSubagentDefinitions, type DefinitionOptions,
} from "./agent_definition.js";
import { ANTIGRAVITY_TOOL_GATE_SOURCE, antigravitySubagentTools, computeAntigravityToolPolicy } from "./tool_policy.js";

interface WorkspaceOptions extends DefinitionOptions {
  directory: string;
  profileWorkspaceDir: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  fresh: boolean;
}

const START_HOOK = `"use strict";
const fs = require("node:fs");
const chunks = process.argv.slice(2).map(file => fs.readFileSync(file, "utf8"));
process.stdout.write(JSON.stringify({ injectSteps: chunks.map(chunk => ({ systemMessage: { systemMessage: chunk } })) }));
`;

function chunksOf(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let size = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const lineSize = Buffer.byteLength(line);
    if (size + lineSize <= 19000) { chunk += line; size += lineSize; continue; }
    if (chunk) { chunks.push(chunk); chunk = ""; size = 0; }
    for (const character of line) {
      const bytes = Buffer.byteLength(character);
      if (size + bytes > 19000) { chunks.push(chunk); chunk = ""; size = 0; }
      chunk += character; size += bytes;
    }
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

async function privateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

function command(...args: string[]): string {
  return args.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
}

export async function writeAntigravityDefaultWorkspace(options: WorkspaceOptions): Promise<void> {
  const { directory } = options;
  const agentsDir = join(directory, ".agents");
  const chunksDir = join(directory, "instructions");
  if (options.fresh) await rm(directory, { recursive: true, force: true });
  await mkdir(agentsDir, { recursive: true, mode: 0o700 });
  await mkdir(chunksDir, { recursive: true, mode: 0o700 });

  const policy = options.allowedTools && computeAntigravityToolPolicy({
    allowedTools: options.allowedTools, disallowedTools: options.disallowedTools, agentId: options.agentId,
  });
  const name = antigravityDefinitionName(options.agentSessionId);
  const deniedAgents = new Set((options.disallowedTools ?? []).flatMap(item => {
    const match = /^Agent\(([^)]+)\)$/.exec(item.trim());
    return match ? [match[1]!] : [];
  }));
  const subagents = policy?.definitionTools.includes("invoke_subagent")
    ? (await readClaudeSubagentDefinitions(options.profileWorkspaceDir, options.logger)).filter(agent => !deniedAgents.has(agent.name))
    : [];
  const listings = subagents.map(agent => ({ originalName: agent.name, invokeName: `${name}-${agent.name}`, description: agent.description }));
  const subagentDir = join(agentsDir, "agents");
  await rm(subagentDir, { recursive: true, force: true });
  if (subagents.length) {
    await mkdir(subagentDir, { recursive: true, mode: 0o700 });
    for (const [index, agent] of subagents.entries()) {
      const invokeName = listings[index]!.invokeName;
      await privateFile(join(subagentDir, `${invokeName}.md`), antigravitySubagentDefinitionText({
        name: invokeName, description: agent.description, tools: antigravitySubagentTools(agent.tools), body: agent.body,
      }));
    }
  }

  if (options.fresh) {
    const chunks = chunksOf(options.systemPrompt + antigravitySubagentSection(listings));
    for (const [index, chunk] of chunks.entries()) await privateFile(join(chunksDir, `chunk-${String(index).padStart(6, "0")}.txt`), chunk);
  }
  const files = (await readdir(chunksDir)).filter(file => /^chunk-\d+\.txt$/.test(file)).sort().map(file => join(chunksDir, file));
  const rulesDir = join(agentsDir, "rules");
  await mkdir(rulesDir, { recursive: true, mode: 0o700 });
  await privateFile(join(rulesDir, "session-instructions.md"), `---\n${stringify({ trigger: "always_on", description: "세션 운영 지침의 위치" })}---\n이 세션의 운영 지침은 대화 첫머리의 시스템 메시지에 있다. 보이지 않으면 다음 파일을 차례로 읽어 따른다: ${files.join(", ")}\n`);
  const startPath = join(directory, "session-start.cjs");
  await privateFile(startPath, START_HOOK);
  const hooks: Record<string, unknown> = { SessionStart: [{ type: "command", command: command(process.execPath, startPath, ...files), timeout: 10 }] };
  if (policy) {
    const policyPath = join(directory, "policy.json");
    const gatePath = join(directory, "tool-gate.cjs");
    await privateFile(policyPath, JSON.stringify({ ...policy.gate, allowedTools: policy.definitionTools, subagents: listings.map(entry => entry.invokeName) }, null, 2));
    await privateFile(gatePath, ANTIGRAVITY_TOOL_GATE_SOURCE);
    hooks.PreToolUse = [{ matcher: "*", hooks: [{ type: "command", command: command(process.execPath, gatePath, policyPath), timeout: 10 }] }];
  }
  await privateFile(join(agentsDir, "hooks.json"), JSON.stringify({ "soulstream-session": hooks }, null, 2));
  const servers = Object.fromEntries(antigravityMcpServers(options).map(({ name: serverName, url, ...server }) => [serverName, { ...(url ? { serverUrl: url } : {}), ...server }]));
  await privateFile(join(agentsDir, "mcp_config.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}
