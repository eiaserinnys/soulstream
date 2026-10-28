import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { AntigravityEventMapper } from "../../../src/engine/antigravity/events.js";
import { snapshotAntigravityDescendants, cleanUpAntigravityDescendants, launchAntigravityProcess } from "../../../src/engine/antigravity/process.js";

function live(pid: number) {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[0] !== "Z"; }
  catch { return false; }
}
async function gone(pid: number) {
  const deadline = Date.now() + 2000;
  while (live(pid) && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  expect(live(pid)).toBe(false);
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
  it("snapshots a real sleep in a separate process group and cleans only matching starttime", async () => {
    const { parent, pid } = await detachedSleep();
    try {
      const snapshot = snapshotAntigravityDescendants(parent.pid!);
      const child = snapshot.find(x => x.pid === pid)!;
      expect(child).toBeDefined(); expect(child.startTime).toMatch(/^\d+$/);
      expect(snapshot.some(x => x.pid === parent.pid)).toBe(false);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
      expect(Number(stat[2])).toBe(pid); // separate PGID
      expect(cleanUpAntigravityDescendants([{ ...child, startTime: "different-starttime" }])).toBe(0);
      expect(live(pid)).toBe(true);
      expect(cleanUpAntigravityDescendants(snapshot)).toBe(1);
      await gone(pid);
    } finally {
      if (live(pid)) process.kill(pid, "SIGTERM");
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
      if (pid && live(pid)) process.kill(pid, "SIGTERM");
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
    const events=[]; for await (const event of child.events) events.push(event);
    expect(events[0]).toMatchObject({event:"init",conversation_id:resume?"resume":"new"});
    expect(events[1]).toMatchObject({event:"result",result:{status:"ERROR",error:"interrupted"}});
    expect((await child.done).code).toBe(1);
    expect(child.interrupted).toBe(true);
  });
});
