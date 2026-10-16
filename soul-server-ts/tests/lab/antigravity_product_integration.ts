/** Real Antigravity adapter checks. Run ONLY with a mktemp -d root and an outer timeout 180. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rawStepUsage as sum, assertTurnUsage, pairedToolNames as pairs } from "./antigravity_assertions.js";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import pino from "pino";
import { parse } from "yaml";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AntigravityEngineAdapter } from "../../src/engine/antigravity/adapter.js";
import { resolveAntigravityCliPath } from "../../src/engine/antigravity_cli_path.js";
import { AntigravityEventMapper, type AntigravityEvent } from "../../src/engine/antigravity/events.js";
import type { EngineExecuteParams, SSEEventPayload } from "../../src/engine/protocol.js";

const root = process.argv[2];
assert(root && resolve(root).startsWith("/tmp/"), "Pass a mktemp -d root under /tmp");
assert.equal((await readdir(root)).length, 0, "Scratch root must start empty");
const executablePath = resolveAntigravityCliPath(process.env)?.path;
assert(executablePath, "agy must be installed");
const workspace = join(root, "workspace");
const state = join(root, "state");
const stdioCwd = join(root, "stdio-workspace");
await Promise.all([workspace, state, stdioCwd].map(async dir => await mkdir(dir, { mode: 0o700 })));
const marker = `SYSTEM_${Date.now()}`;
const memory = `MEMORY_${Date.now()}`;
const sessionId = `agy-lab-${Date.now()}`;
const probeHeader = "fixture-auth-only";
const stdioReceipt = join(root, "stdio-receipt.json");
const httpReceipts: Array<{ path: string; header: boolean; session: boolean; tool: string }> = [];
const http = createServer(async (request, response) => {
  const server = new McpServer({ name: "agy-lab", version: "1.0.0" });
  server.registerTool("probe_echo", { description: "Return HTTP probe marker" }, async () => {
    httpReceipts.push({ path: request.url ?? "", header: request.headers["x-probe"] === probeHeader,
      session: request.headers["x-soulstream-agent-session-id"] === sessionId, tool: "probe_echo" });
    return { content: [{ type: "text", text: "HTTP_PROBE_OK" }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on("close", () => { void transport.close(); void server.close(); });
  try { await server.connect(transport); await transport.handleRequest(request, response); }
  catch { response.writeHead(500).end(); }
});
await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
const address = http.address(); assert(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}/mcp`;
const require = createRequire(import.meta.url);
const stdioScript = join(root, "stdio-probe.mjs");
await writeFile(stdioScript, `
import { McpServer } from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href)};
import { writeFileSync } from 'node:fs';
const server=new McpServer({name:'stdio-probe',version:'1.0.0'});
server.registerTool('probe_env',{description:'Return STDIO_PROBE_OK and verify env/cwd'},async()=>{
 const ok=process.env.PROBE_MARKER==='STDIO_PROBE_OK' && process.cwd()===process.env.PROBE_CWD;
 writeFileSync(process.env.PROBE_RECEIPT,JSON.stringify({ok}),{mode:0o600});
 return {content:[{type:'text',text:ok?'STDIO_PROBE_OK':'STDIO_PROBE_FAILED'}]};
});
await server.connect(new StdioServerTransport());
`, { mode: 0o600 });
const engine = new AntigravityEngineAdapter({ workspaceDir: workspace, agentId: "lab", sessionDirectory: state,
  executablePath, processEnv: process.env, internalMcpUrl: url,
  resolvedMcpServers: [
    { name: "http-probe", type: "streamable_http", url, headers: { "x-probe": probeHeader } },
    { name: "stdio-probe", type: "stdio", command: process.execPath, args: [stdioScript], cwd: stdioCwd,
      env: { PROBE_MARKER: "STDIO_PROBE_OK", PROBE_CWD: stdioCwd, PROBE_RECEIPT: stdioReceipt } },
    { name: "soulstream", type: "streamable_http", url: "http://obsolete.invalid/mcp", headers: { "x-probe": probeHeader } },
  ],
}, pino({ level: "silent" }));

// Observe the native boundary, analogous to the Claude lab's wrapped SDK query.
// Compute independent raw-step arithmetic; never print raw text/headers/logs.
let raw: AntigravityEvent[] = [];
const originalAccept = AntigravityEventMapper.prototype.accept;
AntigravityEventMapper.prototype.accept = function(event) { raw.push(event); return originalAccept.call(this, event); };
function text(events: SSEEventPayload[]) {
  const content=events.filter(x => x.type === "assistant_message").map(x => x.content).join("\n");
  assert(/[가-힣]/.test(content), "Response must preserve Korean");
  assert(!content.includes("�"), "Response must not contain replacement characters");
  return content;
}
function descendants(rows: ReturnType<typeof processRows>, parent: number): ReturnType<typeof processRows> {
  const children = rows.filter(x=>x.ppid===parent);
  return children.flatMap(child=>[child,...descendants(rows,child.pid)]);
}
function processRows() {
  return execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,stat=,comm="], {encoding:"utf8",timeout:5000}).trim().split("\n").map(line=>{
    const [pid,ppid,pgid,state,command]=line.trim().split(/\s+/); return {pid:Number(pid),ppid:Number(ppid),pgid:Number(pgid),state:state!,command,startTime:undefined as string|undefined,marked:false};
  });
}
async function defaultLogs() {
  try { return (await readdir(join(homedir(), ".gemini/antigravity-cli/log"))).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}
const agentsDirectory = join(homedir(), ".gemini/config/agents");
function definitionPath(id: string) {
  return join(agentsDirectory, `soulstream-${createHash("sha256").update(id).digest("hex").slice(0,24)}.md`);
}
async function definitionNames() {
  try { return (await readdir(agentsDirectory)).filter(name=>name.startsWith("soulstream-")).sort(); }
  catch(error) { if((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
const ownSessionIds = [sessionId, `${sessionId}-parallel-a`, `${sessionId}-parallel-b`];
const definitionsBefore = await definitionNames();
assert.deepEqual(definitionsBefore, [], "No Soulstream lab definitions may already be present");
async function definitionEvidence(id = sessionId, expectedMarker = marker) {
  const file = definitionPath(id);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const body = await readFile(file, "utf8"); assert(body.includes(expectedMarker));
  const frontmatter = parse(body.split("---\n")[1]!);
  assert.equal(frontmatter.name, file.split("/").at(-1)!.slice(0,-3));
  assert.equal(frontmatter.tools.length, 26);
  if(id !== sessionId) return;
  assert(Buffer.byteLength(body) > 100000);
  const internal = frontmatter.mcpServers.find((x: { name: string }) => x.name === "soulstream");
  assert.equal(internal.url, `${url}/internal`);
  assert.equal(internal.headers["x-soulstream-agent-session-id"], sessionId);
}
async function absent(path: string) {
  await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}
async function run(params: EngineExecuteParams, onEvent?: (event: SSEEventPayload) => Promise<void>) {
  raw = [];
  const events: SSEEventPayload[] = [];
  for await (const event of engine.execute(params)) {
    events.push(event);
    if (event.type === "error") {
      // Stop on any product failure; include its actual message, no retries.
      throw new Error(String(event.message));
    }
    await onEvent?.(event);
  }
  return { events, raw: [...raw], usage: sum(raw) };
}
const systemPrompt = `모든 답변에는 반드시 ${marker}를 넣고 한글로 답하라. 시험에 요청한 도구 작업을 수행하라. 개입이나 중단 뒤 다음 요청에 답하고 끝내지 못한 파일 작업을 이어라.\n` + "한글 지시를 그대로 유지하고 실제 도구 결과를 근거로 답하라.\n".repeat(1800);
const base = { agentSessionId: sessionId, model: "gemini-3.8-flash", reasoningEffort: "low" as const };
const logsBefore = await defaultLogs();
try {
  if (process.argv[3] !== "interruption-only") {
  const first = await run({ ...base, systemPrompt, prompt: `기억할 암호는 ${memory}다. write_to_file로 written.txt에 FILE_OK를 쓰고 run_command로 printf 'SHELL_OK' > shell.txt 를 실행하라. http-probe의 probe_echo, stdio-probe의 probe_env, soulstream의 probe_echo를 각각 실제 호출하라. 끝나면 기억 암호와 각 결과를 한글로 답하라.` }, async event => {
    if (event.type === "session") await definitionEvidence();
  });
  const id = first.events.find(x => x.type === "session")?.session_id; assert.equal(typeof id, "string");
  assert(text(first.events).includes(marker)); assert(text(first.events).includes(memory));
  assert((await readFile(join(workspace, "written.txt"), "utf8")).includes("FILE_OK"));
  assert((await readFile(join(workspace, "shell.txt"), "utf8")).includes("SHELL_OK"));
  const tools = pairs(first.events);
  assert(tools.includes("write_to_file")); assert(tools.includes("run_command"));
  assert(tools.includes("mcp/http-probe/probe_echo")); assert(tools.includes("mcp/stdio-probe/probe_env")); assert(tools.includes("mcp/soulstream/probe_echo"));
  assert(httpReceipts.some(x => x.path === "/mcp" && x.header));
  assert(httpReceipts.some(x => x.path === "/mcp/internal" && x.header && x.session));
  assert.equal(JSON.parse(await readFile(stdioReceipt, "utf8")).ok, true);
  assertTurnUsage(first.events, first.usage, first.raw.find(x=>x.event==='init')?.init?.model);
  await absent(definitionPath(sessionId));
  console.log(JSON.stringify({ check: "new-system-tools-mcp-usage", passed: true, id, tools, usage: first.usage }));


  }

  // Interrupt a new conversation's first turn in a long foreground shell, then resume.
  const sleepMarker = `AGY_SLEEP_${Date.now()}`;
  let interrupted = false;
  let interruptedGroup: number | undefined;
  let observedChildren: ReturnType<typeof processRows> = [];
  const before = await run({ ...base, systemPrompt, prompt: `순서대로 run_command로 printf 'STAGE_ONE' > stage-one.txt 를 실행하고, run_command로 bash -c 'exec -a ${sleepMarker} sleep 90' 을 실행한 뒤, write_to_file로 stage-three.txt에 STAGE_THREE를 써라. 반드시 각 단계를 별도 도구 호출로 수행하고 긴 명령을 백그라운드로 떼어 내지 마라.` }, async event => {
    if(event.type === "session") await definitionEvidence();
    if(event.type === "tool_start" && event.tool_name === "run_command" && JSON.stringify(event.tool_input).includes("sleep 90")) {
      interrupted = true;
      await new Promise(done => setTimeout(done, 500));
      const running = processRows();
      interruptedGroup = running.find(x=>x.ppid===process.pid && x.pgid===x.pid)?.pgid;
      assert(interruptedGroup, "CLI owns a distinct process group");
      observedChildren = descendants(running, interruptedGroup);
      assert(observedChildren.some(x=>x.command==='sleep' && !x.state.startsWith('Z')), "Long sleep tool must actually be alive before SIGINT");
      for (const child of observedChildren) {
        const fields=(await readFile(`/proc/${child.pid}/stat`, "utf8")).split(") ").at(-1)!.split(" ");
        child.startTime=fields[19];
        child.marked=(await readFile(`/proc/${child.pid}/cmdline`, "utf8")).split("\0").includes(sleepMarker);
      }
      assert(observedChildren.some(x=>x.marked), "Marked sleep must be present in the snapshot");
      assert.deepEqual(await engine.intervene({ prompt: "새 정보" }), {status:"not_delivered",mechanism:"interrupt_then_next_turn",reason:"next_turn_required"});
    }
  });
  assert(interrupted);
  assert(!before.events.some(x => ["error","complete"].includes(x.type)));
  const interruptedId = before.events.find(x => x.type === "session")?.session_id; assert.equal(typeof interruptedId,"string");
  await absent(definitionPath(sessionId));
  const after = await run({ ...base, resumeSessionId:String(interruptedId), prompt: "새 정보는 NEW_INFO다. NEW_INFO에 답하고 원래 하던 일을 마쳐라. 기다리던 명령은 취소됐으니 다시 90초 기다릴 필요 없이 나머지 파일 작업을 완료하라. http-probe의 probe_echo와 stdio-probe의 probe_env를 다시 실제 호출하라." });
  assert(text(after.events).includes(marker)); assert(text(after.events).includes("NEW_INFO"));
  try {
    assert((await readFile(join(workspace,"stage-three.txt"),"utf8")).includes("STAGE_THREE"));
  } catch(error) {
    console.log(JSON.stringify({check:"resume-workspace",passed:false,
      init: after.raw.find(x=>x.event==='init'),
      fileToolArguments: after.raw.filter(x=>x.step_update?.tool_info?.name==='write_to_file').map(x=>x.step_update!.tool_info!.parameters)}));
    throw error;
  }
  assert.equal(after.events.find(x=>x.type==='session')?.session_id,interruptedId);
  const afterTools=pairs(after.events); assert(afterTools.includes("mcp/http-probe/probe_echo")); assert(afterTools.includes("mcp/stdio-probe/probe_env"));
  const expected=Object.fromEntries(Object.entries(before.usage).map(([key,value])=>[key,value+after.usage[key as keyof typeof after.usage]]));
  assertTurnUsage(after.events, expected as typeof after.usage, after.raw.find(x=>x.event==='init')?.init?.model);
  async function markedSurvivors() {
    const survivors=[];
    for (const child of observedChildren.filter(x=>x.marked)) {
      try {
        const fields=(await readFile(`/proc/${child.pid}/stat`, "utf8")).split(") ").at(-1)!.split(" ");
        if(fields[0]!=="Z" && fields[19]===child.startTime) survivors.push({pid:child.pid,ppid:Number(fields[1]),pgid:Number(fields[2]),startTime:fields[19],inSnapshot:true});
      } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
    }
    return survivors;
  }
  let remaining=await markedSurvivors();
  if(remaining.length) { await new Promise(done=>setTimeout(done,2000)); remaining=await markedSurvivors(); }
  if(remaining.length) console.log(JSON.stringify({check:"marked-sleep-cleanup",passed:false,remaining}));
  assert.equal(remaining.length,0,"Interrupted marked sleep must be gone after the resumed turn");
  console.log(JSON.stringify({check:"process-descendant-cleanup",passed:true,observedChildren:observedChildren.length,liveMarkedSleepBeforeSignal:true,survivingProcesses:remaining.length}));
  console.log(JSON.stringify({check:"first-turn-interrupt-resume-carry",passed:true,id:interruptedId,interruptedUsage:before.usage,resumedUsage:after.usage,completeUsage:expected}));
  await absent(join(workspace,".agents"));
  assert.deepEqual(await readdir(state), ["antigravity.log"]);
  for(const directory of [homedir(), agentsDirectory]) {
    for(const name of ["written.txt","shell.txt","stage-one.txt","stage-three.txt"]) await absent(join(directory,name));
  }

  // Two simultaneous first turns must retain their own named system definitions.
  const parallelEngines: AntigravityEngineAdapter[] = [];
  let initialized = 0;
  let release!: () => void;
  const overlap = new Promise<void>(done=> { release=done; });
  try {
    const parallel = await Promise.all(ownSessionIds.slice(1).map(async (id,index) => {
      const cwd = join(root,`parallel-workspace-${index}`);
      const directory = join(root,`parallel-state-${index}`);
      await mkdir(cwd,{mode:0o700}); await mkdir(directory,{mode:0o700});
      const token = `PARALLEL_${index}_${Date.now()}`;
      const otherToken = `PARALLEL_${1-index}_`;
      const adapter = new AntigravityEngineAdapter({workspaceDir:cwd,agentId:"lab",sessionDirectory:directory,executablePath,processEnv:process.env},pino({level:"silent"}));
      parallelEngines.push(adapter);
      const events:SSEEventPayload[]=[];
      for await(const event of adapter.execute({...base,agentSessionId:id,useMcp:false,systemPrompt:`한글 문장으로 답하고 반드시 ${token}를 포함하라. 다른 표식은 답하지 마라.`,prompt:"시스템 지시의 표식을 말하라."})) {
        if(event.type==='error') throw new Error(String(event.message));
        events.push(event);
        if(event.type==='session') {
          await definitionEvidence(id,token);
          initialized++;
          if(initialized===2) {
            await Promise.all(ownSessionIds.slice(1).map(other=>stat(definitionPath(other))));
            release();
          }
          await overlap;
        }
      }
      assert(text(events).includes(token)); assert(!text(events).includes(otherToken));
      assert.equal(events.filter(x=>x.type==='complete').length,1);
      await absent(definitionPath(id));
      return {sessionId:id,ownInstruction:true};
    }));
    console.log(JSON.stringify({check:"parallel-first-turn-definitions",passed:true,overlappingDefinitions:initialized,parallel}));
  } finally {
    release();
    await Promise.all(parallelEngines.map(adapter=>adapter.close()));
  }
  assert.deepEqual(await definitionNames(),definitionsBefore);
  assert.equal(await defaultLogs(),logsBefore);
  console.log(JSON.stringify({check:"private-definition-cleanup-default-log-count",passed:true,logsBefore,logsAfter:await defaultLogs()}));
} finally {
  await engine.close();
  await Promise.all(ownSessionIds.map(id=>rm(definitionPath(id),{force:true})));
  AntigravityEventMapper.prototype.accept = originalAccept;
  http.closeAllConnections();
  await new Promise<void>(done=>http.close(()=>done()));
}
