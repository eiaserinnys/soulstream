import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { AntigravityEventMapper } from "../../../src/engine/antigravity/events.js";
import { snapshotAntigravityDescendants, cleanUpAntigravityDescendants, launchAntigravityProcess } from "../../../src/engine/antigravity/process.js";

type ProcessObservation = { state: "live" | "dead" | "unknown"; detail: string };

function observeProcess(pid: number): ProcessObservation {
  try {
    let state: string;
    if (process.platform === "darwin") {
      process.kill(pid, 0);
      state = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
    } else {
      state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[0]!;
    }
    return { state: state.startsWith("Z") ? "dead" : "live", detail: state };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { state: code === "ENOENT" || code === "ESRCH" ? "dead" : "unknown", detail: code ?? String(error) };
  }
}
function mayNeedCleanup(pid: number) {
  return observeProcess(pid).state !== "dead";
}
async function gone(pid: number, observe = observeProcess) {
  const deadline = performance.now() + 2000;
  let observation = observe(pid);
  while (observation.state !== "dead" && performance.now() < deadline) {
    await new Promise(done => setTimeout(done, 20));
    observation = observe(pid);
  }
  expect(observation.state, `last process observation: ${observation.detail}`).toBe("dead");
}
async function detachedSleep() {
  const parent = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const child=spawn('sleep',['60'],{detached:true,stdio:'ignore'});
    console.log(child.pid); setInterval(()=>{},1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  const [data] = await once(parent.stdout!, "data");
  return { parent, pid: Number(data.toString().trim()) };
}

describe("Antigravity process descendants", () => {
  it("waits through an unknown observation and stops on the observed death", async () => {
    const observe = vi.fn()
      .mockReturnValueOnce({ state: "unknown", detail: "EIO" })
      .mockReturnValueOnce({ state: "dead", detail: "Z" })
      .mockReturnValueOnce({ state: "live", detail: "S" });
    await gone(123, observe);
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("reports the last observation when death is not observed by the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const observe = vi.fn(() => ({ state: "unknown" as const, detail: "EIO" }));
      const result = expect(gone(123, observe)).rejects.toThrow("EIO");
      await vi.advanceTimersByTimeAsync(2000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a completed result when Windows tree termination fails", async () => {
    const terminateProcessTree = vi.fn(async (pid: number) => {
      process.kill(-pid, "SIGKILL");
      throw new Error("process not found");
    });
    const source = `console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'finished'}}));
      setInterval(()=>{},1000); setTimeout(()=>process.exit(0),2000);`;
    const child = launchAntigravityProcess({ executablePath: process.execPath, args: ["-e", source],
      cwd: "/tmp", env: process.env, input: "", logger: pino({ level: "silent" }), exitGraceMs: 30,
      platform: "win32", terminateProcessTree });
    for await (const _event of child.events) { /* consume result */ }
    const exit = await child.done;
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(exit.forcedAfterResult).toBe(true);
    expect(exit.error).toBeUndefined();
  });
  it.each(["result", "interrupt"] as const)("uses Windows tree termination after %s", async trigger => {
    const terminateProcessTree = vi.fn(async (pid: number) => { process.kill(-pid, "SIGKILL"); });
    const source = `const emit=x=>console.log(JSON.stringify(x));
      emit({event:'init',conversation_id:'fixture'});
      ${trigger === "result" ? "emit({event:'result',result:{status:'SUCCESS',response:'finished'}});" : ""}
      setInterval(()=>{},1000); setTimeout(()=>process.exit(0),2000);`;
    const child = launchAntigravityProcess({ executablePath: process.execPath, args: ["-e", source],
      cwd: "/tmp", env: process.env, input: "", logger: pino({ level: "silent" }), exitGraceMs: 30,
      platform: "win32", terminateProcessTree });
    for await (const event of child.events) {
      if (trigger === "interrupt" && event.event === "init") expect(child.interrupt()).toBe(true);
    }
    const exit = await child.done;
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(expect.any(Number));
    expect(child.interruptSignalled).toBe(trigger === "interrupt");
    if (trigger === "result") expect(exit.forcedAfterResult).toBe(true);
  });
  it("snapshots a real sleep in a separate process group and cleans only matching starttime", async () => {
    const { parent, pid } = await detachedSleep();
    try {
      const snapshot = snapshotAntigravityDescendants(parent.pid!);
      const child = snapshot.find(x => x.pid === pid)!;
      expect(child).toBeDefined();
      expect(child.startTime).toMatch(process.platform === "darwin"
        ? /^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/
        : /^\d+$/);
      expect(snapshot.some(x => x.pid === parent.pid)).toBe(false);
      if (process.platform !== "darwin") {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
        expect(Number(stat[2])).toBe(pid); // separate PGID
      }
      expect(cleanUpAntigravityDescendants([{ ...child, startTime: "different-starttime" }])).toBe(0);
      const seen = observeProcess(pid);
      expect(seen.state, `process observation: ${seen.detail}`).toBe("live");
      expect(cleanUpAntigravityDescendants(snapshot)).toBe(1);
      await gone(pid);
    } finally {
      if (mayNeedCleanup(pid)) process.kill(pid, "SIGTERM");
      parent.kill("SIGTERM"); await once(parent, "close");
    }
  });
  it("captures descendants at SIGINT, cleans after close and logs only the count", async () => {
    const warn = vi.fn();
    const source = `const {spawn}=require('node:child_process');
      const child=spawn('sleep',['60'],{detached:true,stdio:'ignore'});
      const emit=x=>console.log(JSON.stringify(x));
      process.on('SIGINT',()=>{emit({event:'result',result:{status:'ERROR',error:'interrupted'}});process.exit(1)});
      emit({event:'init',conversation_id:'fixture',init:{model:'fixture'}});
      emit({event:'step_update',step_update:{step_index:1,step_type:'tool',state:'ACTIVE',conversation_id:'fixture',tool_info:{name:'sleep',parameters:{pid:child.pid}}}});
      setInterval(()=>{},1000);`;
    const child = launchAntigravityProcess({ executablePath: process.execPath, args: ["-e",source], cwd: "/tmp", env: process.env, input: "", logger: {warn} });
    let pid = 0;
    try {
      for await (const event of child.events) if (event.step_update?.tool_info) {
        pid = Number((event.step_update.tool_info.parameters as {pid:number}).pid);
        expect(child.interrupt()).toBe(true);
      }
      expect((await child.done).code).toBe(1);
      await gone(pid);
      expect(warn).toHaveBeenCalledWith({ terminatedProcessCount: 1 }, expect.any(String));
    } finally {
      if (pid && mayNeedCleanup(pid)) process.kill(pid, "SIGTERM");
    }
  });
  it("force-kills a CLI that stays alive after a successful result and keeps the completion", async () => {
    const source = `const emit=x=>console.log(JSON.stringify(x));
      emit({event:'result',result:{status:'SUCCESS',response:'finished'}});
      process.stdout.end(); setInterval(()=>{},1000); setTimeout(()=>process.exit(0),2000);`;
    const child = launchAntigravityProcess({ executablePath: process.execPath, args: ["-e", source],
      cwd: "/tmp", env: process.env, input: "", logger: pino({ level: "silent" }), exitGraceMs: 30 });
    const events = [];
    for await (const event of child.events) events.push(event);

    const exit = await child.done;
    const mapper = new AntigravityEventMapper("forced-turn");
    for (const event of events) mapper.accept(event);
    expect(exit).toMatchObject({ signal: "SIGKILL", forcedAfterResult: true });
    expect(mapper.terminal(exit, false)).toMatchObject([{ type: "complete", status: "completed", result: "finished" }]);
  });
  it("force-kills a CLI that ignores SIGINT after the exit grace", async () => {
    const source = `const emit=x=>console.log(JSON.stringify(x));
      process.on('SIGINT',()=>{});
      emit({event:'init',conversation_id:'fixture',init:{model:'fixture'}});
      setInterval(()=>{},1000); setTimeout(()=>process.exit(0),2000);`;
    const child = launchAntigravityProcess({ executablePath: process.execPath, args: ["-e", source],
      cwd: "/tmp", env: process.env, input: "", logger: pino({ level: "silent" }), exitGraceMs: 30 });
    for await (const event of child.events) {
      if (event.event === "init") expect(child.interrupt()).toBe(true);
    }

    const exit = await child.done;
    expect(exit.signal).toBe("SIGKILL");
    expect(exit.forcedAfterResult).toBeUndefined();
    expect(child.interrupted).toBe(true);
  });
  it.each([false,true])("defers an interruption before init until init (%s resume-like fixture)", async resume => {
    const source = `const emit=x=>console.log(JSON.stringify(x)); let initialized=false;
      process.on('SIGINT',()=>{emit({event:'result',result:{status:initialized?'ERROR':'EARLY',error:'interrupted'}});process.exit(initialized?1:9)});
      setTimeout(()=>{initialized=true;emit({event:'init',conversation_id:'${resume ? "resume" : "new"}',init:{model:'fixture'}})},100);
      setInterval(()=>{},1000);`;
    const child = launchAntigravityProcess({ executablePath: process.execPath,args:["-e",source],cwd:"/tmp",env:process.env,input:"",logger:pino({level:"silent"}) });
    expect(child.interrupt()).toBe(true);
    expect(child.interruptSignalled).toBe(false);
    const events=[]; for await (const event of child.events) events.push(event);
    expect(events[0]).toMatchObject({event:"init",conversation_id:resume?"resume":"new"});
    expect(events[1]).toMatchObject({event:"result",result:{status:"ERROR",error:"interrupted"}});
    expect((await child.done).code).toBe(1);
    expect(child.interrupted).toBe(true);
    expect(child.interruptSignalled).toBe(true);
  });
  it("does not mark an interrupt as signalled when the process exits before init", async () => {
    const child = launchAntigravityProcess({ executablePath: process.execPath, args: ["-e", "process.exit(1)"],
      cwd: "/tmp", env: process.env, input: "", logger: pino({ level: "silent" }) });
    expect(child.interrupt()).toBe(true);
    for await (const _event of child.events) { /* drain */ }
    expect((await child.done).code).toBe(1);
    expect(child.interruptSignalled).toBe(false);
  });
});
