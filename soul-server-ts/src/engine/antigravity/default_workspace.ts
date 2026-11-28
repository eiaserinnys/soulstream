import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import {
  antigravityMcpServers, antigravitySubagentSection, readClaudeSubagentDefinitions, type DefinitionOptions,
} from "./agent_definition.js";
import { ANTIGRAVITY_TOOL_GATE_SOURCE, antigravitySubagentTools, computeAntigravityToolPolicy } from "./tool_policy.js";

interface WorkspaceOptions extends DefinitionOptions {
  directory: string;
  profileWorkspaceDir: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  parentConversationFile: string;
  protectedPaths: string[];
  fresh: boolean;
}

function containsPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function antigravityWorkspacePaths(sessionDirectory: string, cwd: string, home: string) {
  const session = resolve(sessionDirectory);
  const workspace = resolve(cwd);
  const physical = join(session, "antigravity-workspace");
  const parent = dirname(session);
  const key = createHash("sha256").update(parent).digest("hex");
  const link = join(resolve(home), "~soulstream-agy", key);
  const ordered = join(link, basename(session), "antigravity-workspace");
  if (containsPath(workspace, physical)) {
    throw new Error("Antigravity configuration workspace must be outside the profile workspace");
  }
  const fallback = containsPath(workspace, ordered) || Buffer.compare(Buffer.from(ordered), Buffer.from(workspace)) <= 0;
  return { physical, ordered, link, parent, addDir: fallback ? physical : ordered, fallback };
}

export async function prepareAntigravityWorkspaceLink(paths: ReturnType<typeof antigravityWorkspacePaths>): Promise<void> {
  if (paths.fallback) return;
  await mkdir(dirname(paths.link), { recursive: true, mode: 0o700 });
  try {
    await symlink(paths.parent, paths.link, "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readlink(paths.link) !== paths.parent) throw error;
  }
}

const START_HOOK = `"use strict";
const fs = require("node:fs");
const config = JSON.parse(process.argv[2]);
let input;
try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch (error) {}
let parentConversation = "";
try { parentConversation = fs.readFileSync(config.parentConversationFile, "utf8").trim(); } catch (error) {}
const isSubagent = input && typeof input.conversationId === "string" && parentConversation !== "" && input.conversationId !== parentConversation;
let messages;
if (isSubagent) {
  const agents = config.subagents.map(agent => ({ name: agent.name, body: fs.readFileSync(agent.file, "utf8") }));
  messages = agents.length <= 1 ? agents.map(agent => agent.body) : [
    "부모가 Role에 적은 이름에 해당하는 지침을 따른다.\\n\\n" + agents.map(agent => "## " + agent.name + "\\n\\n" + agent.body).join("\\n\\n")
  ];
} else {
  messages = config.chunks.map(file => fs.readFileSync(file, "utf8"));
}
process.stdout.write(JSON.stringify({ injectSteps: messages.map(message => ({ systemMessage: { systemMessage: message } })) }));
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
  const deniedAgents = new Set((options.disallowedTools ?? []).flatMap(item => {
    const match = /^Agent\(([^)]+)\)$/.exec(item.trim());
    return match ? [match[1]!] : [];
  }));
  const subagents = policy?.definitionTools.includes("invoke_subagent")
    ? (await readClaudeSubagentDefinitions(options.profileWorkspaceDir, options.logger)).filter(agent => !deniedAgents.has(agent.name))
    : [];
  const listings = subagents.map(agent => ({ name: agent.name, description: agent.description }));
  await rm(join(agentsDir, "agents"), { recursive: true, force: true });
  const subagentDir = join(directory, "subagent-instructions");
  await rm(subagentDir, { recursive: true, force: true });
  await mkdir(subagentDir, { recursive: true, mode: 0o700 });
  const subagentFiles = [];
  for (const agent of subagents) {
    const file = join(subagentDir, `${agent.name}.txt`);
    await privateFile(file, agent.body);
    subagentFiles.push({ name: agent.name, file });
  }

  if (options.fresh) {
    const chunks = chunksOf(options.systemPrompt + antigravitySubagentSection(listings));
    for (const [index, chunk] of chunks.entries()) await privateFile(join(chunksDir, `chunk-${String(index).padStart(6, "0")}.txt`), chunk);
  }
  const files = (await readdir(chunksDir)).filter(file => /^chunk-\d+\.txt$/.test(file)).sort().map(file => join(chunksDir, file));
  const rulesDir = join(agentsDir, "rules");
  await mkdir(rulesDir, { recursive: true, mode: 0o700 });
  await privateFile(join(rulesDir, "session-instructions.md"), `---\n${stringify({ trigger: "always_on", description: "세션 운영 지침의 위치" })}---\n부모 에이전트의 운영 지침은 대화 첫머리의 시스템 메시지에 있다. 부모는 보이지 않으면 다음 파일을 차례로 읽어 따른다: ${files.join(", ")}\n하위 에이전트는 이 부모 지침 파일을 읽거나 따르지 말고, 주입된 자신의 지침을 따른다.\n${antigravitySubagentSection(listings)}`);
  const startPath = join(directory, "session-start.cjs");
  await privateFile(startPath, START_HOOK);
  const hookConfig = JSON.stringify({ parentConversationFile: options.parentConversationFile, chunks: files, subagents: subagentFiles });
  const hooks: Record<string, unknown> = { SessionStart: [{ type: "command", command: command(process.execPath, startPath, hookConfig), timeout: 10 }] };
  if (policy) {
    const policyPath = join(directory, "policy.json");
    const gatePath = join(directory, "tool-gate.cjs");
    await privateFile(policyPath, JSON.stringify({ ...policy.gate, allowedTools: policy.definitionTools,
      subagents: listings.map(entry => entry.name), parentConversationFile: options.parentConversationFile,
      protectedPaths: options.protectedPaths,
      subagentTools: [...new Set(subagents.flatMap(agent => antigravitySubagentTools(agent.tools)))] }, null, 2));
    await privateFile(gatePath, ANTIGRAVITY_TOOL_GATE_SOURCE);
    hooks.PreToolUse = [{ matcher: "*", hooks: [{ type: "command", command: command(process.execPath, gatePath, policyPath), timeout: 10 }] }];
  }
  await privateFile(join(agentsDir, "hooks.json"), JSON.stringify({ "soulstream-session": hooks }, null, 2));
  const servers = Object.fromEntries(antigravityMcpServers(options).map(({ name: serverName, url, ...server }) => [serverName, { ...(url ? { serverUrl: url } : {}), ...server }]));
  await privateFile(join(agentsDir, "mcp_config.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}
