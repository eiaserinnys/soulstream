import { existsSync, readFileSync, writeFileSync, chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityEngineAdapter } from "../../../src/engine/antigravity/adapter.js";
import { makeTempDirSync } from "../../helpers/temp_dir.js";

// Like the existing stdio transport tests, use an isolated Node fixture process.
// This verifies stdin EOF, process close, SIGINT and file lifetime without calling agy.
function fixture(processEnv: NodeJS.ProcessEnv = process.env) {
  const directory = makeTempDirSync("agy-adapter-");
  const executable = join(directory, "fake-agy.mjs");
  writeFileSync(executable, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args=process.argv.slice(2);
const value=(key)=>args[args.indexOf(key)+1];
const emit=(x)=>console.log(JSON.stringify(x));
const model=value('--model');
if(model==='environment'){
 const names=['SCRATCH_WORKSPACE_DIR','SOULSTREAM_AGENT_ID','AGENT_COMMON_FILES_DIR','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GEMINI_BASE_URL'];
 const env=Object.fromEntries(names.filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
 emit({event:'init',conversation_id:'fixture-conversation',init:{model}});
 emit({event:'result',result:{status:'SUCCESS',response:JSON.stringify(env)}});
 process.exit(0);
}
if(model==='parse-error'){console.log('not json');process.exit(0);}
let input=''; for await(const chunk of process.stdin) input+=chunk;
const prompt=JSON.parse(input).message.content;
const id=args.includes('--conversation')?value('--conversation'):'fixture-conversation';
emit({event:'init',conversation_id:id,init:{model}});
emit({event:'step_update',step_update:{conversation_id:id,step_index:0,state:'DONE',step_type:'agent_response',text_delta:'한글',usage:{input_tokens:2,cache_read_tokens:3,output_tokens:4,thinking_tokens:1}}});
if(model==='blocking'){
 process.on('SIGINT',()=>{emit({event:'result',result:{status:'ERROR',error:'interrupted'}});process.exit(1)});
 setInterval(()=>{},1000);
}else if(model==='missing-result'){process.exit(0)}else{
 if(model==='stale-quota'||model==='current-quota'||model==='long-quota'){
  if(model==='current-quota') emit({event:'step_update',step_update:{conversation_id:id,step_index:1,state:'DONE',step_type:'error_message'}});
  const error=model==='long-quota'?'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 54h42m58s.':'Individual quota reached. Resets in 6m57s.';
  emit({event:'result',result:{status:'ERROR',response:'한글',error}});
  process.exit(0);
 }
 emit({event:'result',result:{status:'SUCCESS',response:prompt,usage:{input_tokens:99999}}});
 setTimeout(()=>process.exit(model==='bad-exit'?1:0),30);
}
`);
  chmodSync(executable, 0o700);
  const state = join(directory, "state");
  const engine = new AntigravityEngineAdapter({ workspaceDir: directory, agentId: "test", sessionDirectory: state,
    executablePath: executable, processEnv }, pino({ level: "silent" }));
  return { directory, state, engine };
}
const testHome = makeTempDirSync("agy-adapter-home-");
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => testHome }));
const agents = join(testHome, ".gemini/config/agents");
const definitionFile = () => join(agents, readdirSync(agents).find(name => name.startsWith("soulstream-"))!);
const input = { agentSessionId: "test-session", prompt: "요청", systemPrompt: "지시", model: "normal" };
async function collect(engine: AntigravityEngineAdapter, params = input) {
  const events = []; for await (const event of engine.execute(params)) events.push(event); return events;
}

describe("AntigravityEngineAdapter", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "fixture-conversation"])("passes agent workspace env and strips Google API routing keys (resume: %s)", async resumeSessionId => {
    vi.stubEnv("AGENT_COMMON_FILES_DIR", "/fixture/worker-common");
    const processEnv = {
      ...process.env,
      SCRATCH_WORKSPACE_DIR: undefined,
      SOULSTREAM_AGENT_ID: undefined,
      AGENT_COMMON_FILES_DIR: "/fixture/stale-common",
      GEMINI_API_KEY: "fixture-gemini-key",
      GOOGLE_API_KEY: "fixture-google-key",
      GOOGLE_GEMINI_BASE_URL: "https://fixture.invalid",
    };
    const { engine, directory } = fixture(processEnv);
    try {
      const events = await collect(engine, { ...input, model: "environment", resumeSessionId });
      const complete = events.find(event => event.type === "complete");
      expect(complete).toBeDefined();
      if (complete?.type !== "complete") throw new Error("Fixture did not complete");
      expect(JSON.parse(complete.result!)).toEqual({
        SCRATCH_WORKSPACE_DIR: directory,
        SOULSTREAM_AGENT_ID: "test",
        AGENT_COMMON_FILES_DIR: "/fixture/worker-common",
      });
      expect(processEnv).toMatchObject({
        AGENT_COMMON_FILES_DIR: "/fixture/stale-common",
        GEMINI_API_KEY: "fixture-gemini-key",
        GOOGLE_API_KEY: "fixture-google-key",
        GOOGLE_GEMINI_BASE_URL: "https://fixture.invalid",
      });
    } finally {
      await engine.close();
    }
  });

  it("implements frame/channel execution, waits for close and removes definitions on success", async () => {
    const { engine, directory, state } = fixture();
    const frames: unknown[] = [];
    await engine.executeToFrameChannel(input, { emit: async (frame: unknown) => { frames.push(frame); } } as never);
    expect(frames).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "engine_event", payload: expect.objectContaining({ type: "complete", usage: { input_tokens: 5, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 1 } }) })]));
    expect(readdirSync(agents).filter(name => name.startsWith("soulstream-"))).toEqual([]);
    expect(existsSync(join(state, "antigravity-agent"))).toBe(false);
    expect(existsSync(join(directory, ".agents"))).toBe(false);
    await engine.close();
  });
  it("publishes Antigravity quota exhaustion as a rejected credential alert and a limit-coded error", async () => {
    const { engine } = fixture();
    const startedAt = Date.now();
    try {
      const events = await collect(engine, { ...input, model: "long-quota" });
      const alert = events.find(event => event.type === "credential_alert") as unknown as Record<string, unknown>;
      const error = events.find(event => event.type === "error") as unknown as Record<string, unknown>;
      expect(alert).toMatchObject({ type: "credential_alert", status: "rejected", raw_event_type: "antigravity/result" });
      expect(error).toMatchObject({ type: "error", error_code: "antigravity_quota_exceeded" });
      expect(alert.resets_at).toBe(error.resets_at);
      const resetAt = Date.parse(String(error.resets_at));
      const expectedDelay = (54 * 60 * 60 + 42 * 60 + 58) * 1_000;
      expect(resetAt).toBeGreaterThanOrEqual(startedAt + expectedDelay);
      expect(resetAt).toBeLessThanOrEqual(Date.now() + expectedDelay + 1_000);
    } finally {
      await engine.close();
    }
  });
  it("interrupts without a terminal, resumes same ID, adds usage carry exactly once", async () => {
    const { engine, state } = fixture();
    const events = [];
    for await (const event of engine.execute({ ...input, model: "blocking" })) {
      events.push(event);
      if(event.type === "assistant_message") {
        const file = definitionFile();
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(readFileSync(file,"utf8")).toContain("지시");
        expect(await engine.intervene({ prompt: "새 메시지" })).toEqual({ status: "not_delivered", mechanism: "interrupt_then_next_turn", reason: "next_turn_required" });
      }
    }
    expect(events.map(x=>x.type)).not.toContain("complete"); expect(events.map(x=>x.type)).not.toContain("error");
    expect(readdirSync(agents).filter(name => name.startsWith("soulstream-"))).toEqual([]);
    expect(existsSync(join(state,"antigravity-agent"))).toBe(false);
    const resume = { ...input, resumeSessionId: "fixture-conversation", prompt: "다음" };
    const next = await collect(engine, resume);
    expect(next.find(x=>x.type==='complete')).toMatchObject({ usage: { input_tokens:10,cached_input_tokens:6,output_tokens:8,reasoning_output_tokens:2 } });
    expect((await collect(engine,resume)).find(x=>x.type==='complete')).toMatchObject({ usage: { input_tokens:5,cached_input_tokens:3,output_tokens:4,reasoning_output_tokens:1 } });
    await engine.close();
  });
  it("adds carry to an error too and clears it", async () => {
    const { engine } = fixture();
    for await (const event of engine.execute({ ...input, model: "blocking" })) if(event.type==='assistant_message') await engine.interrupt();
    expect((await collect(engine, { ...input, resumeSessionId:"fixture-conversation", model:"bad-exit" })).find(x=>x.type==='error')).toMatchObject({ usage:{input_tokens:10,output_tokens:8} });
    expect((await collect(engine)).find(x=>x.type==='complete')).toMatchObject({ usage:{input_tokens:5,output_tokens:4} });
    await engine.close();
  });
  it("does not repeat a historical quota after a successful resume, but preserves a new quota", async () => {
    const { engine } = fixture();
    try {
      const resumed = { ...input, resumeSessionId: "fixture-conversation" };
      const recovered = await collect(engine, { ...resumed, model: "stale-quota" });
      expect(recovered.filter(event => event.type === "error")).toEqual([]);
      expect(recovered.filter(event => event.type === "complete")).toHaveLength(1);
      expect(recovered.at(-1)).toMatchObject({ type: "complete", result: "한글", usage: { input_tokens: 5, output_tokens: 4 } });
      const failure = await collect(engine, { ...resumed, model: "current-quota" });
      expect(failure.filter(event => event.type === "error")).toHaveLength(1);
      expect(failure.filter(event => event.type === "complete")).toEqual([]);
      expect((await collect(engine, resumed)).at(-1)).toMatchObject({ type: "complete", usage: { input_tokens: 5 } });
    } finally {
      await engine.close();
    }
  });
  it.each(["parse-error","missing-result","bad-exit"])("returns one fatal for %s and cleans up", async model => {
    const { engine, state }=fixture(); const events=await collect(engine,{ ...input, model });
    expect(events.filter(x=>x.type==='error')).toHaveLength(1); expect(events.filter(x=>x.type==='complete')).toHaveLength(0);
    expect(readdirSync(agents).filter(name => name.startsWith("soulstream-"))).toEqual([]);
    expect(existsSync(join(state,"antigravity-agent"))).toBe(false); await engine.close();
  });
  it("rejects simultaneous turns and closed use; close waits for active process cleanup", async () => {
    const { engine, state }=fixture();
    for await(const event of engine.execute({ ...input, model:"blocking" })) if(event.type==='assistant_message') {
      await expect(collect(engine)).rejects.toThrow(/active/);
      await engine.close();
    }
    expect(readdirSync(agents).filter(name => name.startsWith("soulstream-"))).toEqual([]);
    expect(existsSync(join(state,"antigravity-agent"))).toBe(false);
    await expect(collect(engine)).rejects.toThrow(/closed/);
    expect(await engine.interrupt()).toBe(false);
  });
  it("does not require an installed CLI at construction; execute reports an explicit error", async () => {
    const dir=makeTempDirSync("agy-uninstalled-");
    const engine=new AntigravityEngineAdapter({workspaceDir:dir,agentId:"test",sessionDirectory:join(dir,"state"),processEnv:{}},pino({level:"silent"}));
    expect((await collect(engine))[0]).toMatchObject({type:"error",fatal:true,message:expect.stringContaining("AGY_CLI_PATH")});
    expect(await engine.intervene({prompt:"x"})).toMatchObject({reason:"no_active_turn"});
  });
});

describe("Antigravity new-conversation instructions", () => {
  it("allows an explicit empty system prompt", async () => {
    const {engine} = fixture();
    const events = [];
    for await (const event of engine.execute({...input, systemPrompt:""})) {
      events.push(event);
      if (event.type === "session") expect(readFileSync(definitionFile(), "utf8").split("---\n")[2]).toBe("\n");
    }
    expect(events.find(x=>x.type==='complete')).toBeDefined();
    await engine.close();
  });
  it("shows the approved message for missing system instructions", async () => {
    const {engine} = fixture();
    const events=[]; for await(const event of engine.execute({...input,systemPrompt:undefined})) events.push(event);
    expect(events[0]).toMatchObject({type:"error",fatal:true,message:"이 세션은 첫 턴에서 대화를 만들지 못했습니다. 새 세션을 시작해 주십시오."});
    await engine.close();
  });
});
