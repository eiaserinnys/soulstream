import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readDarwinProcessTable,
  type DarwinProcessRow,
} from "../../../src/engine/antigravity/darwin_process_table.js";
import {
  cleanUpAntigravityDescendants,
  launchAntigravityProcess,
  snapshotAntigravityDescendants,
} from "../../../src/engine/antigravity/process.js";

vi.mock("../../../src/engine/antigravity/darwin_process_table.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/engine/antigravity/darwin_process_table.js")
  >();
  return { ...actual, readDarwinProcessTable: vi.fn() };
});

const originalPlatform = process.platform;
const readTable = vi.mocked(readDarwinProcessTable);

function useDarwin(): void {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
}

function row(
  pid: number,
  ppid: number,
  status = "S",
  startTime = `Tue Nov  4 09:00:0${pid % 10} 2025`,
): DarwinProcessRow {
  return { pid, ppid, status, startTime };
}

afterEach(() => {
  vi.restoreAllMocks();
  readTable.mockReset();
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

describe("Darwin Antigravity descendants", () => {
  it("snapshots the ppid tree without the root", () => {
    useDarwin();
    readTable.mockReturnValue([
      row(10, 1),
      row(11, 10),
      row(12, 10),
      row(13, 12),
      row(20, 1),
    ]);

    expect(snapshotAntigravityDescendants(10).map((child) => child.pid).sort((a, b) => a - b))
      .toEqual([11, 12, 13]);
  });

  it("signals only live descendants whose start time still matches", () => {
    useDarwin();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    readTable.mockReturnValue([
      row(11, 10, "S", "live-start"),
      row(12, 10, "Z", "zombie-start"),
      row(13, 10, "S", "changed-start"),
    ]);

    expect(cleanUpAntigravityDescendants([
      { pid: 11, startTime: "live-start" },
      { pid: 12, startTime: "zombie-start" },
      { pid: 13, startTime: "original-start" },
      { pid: 99, startTime: "missing-start" },
    ])).toBe(1);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(11, "SIGTERM");
  });

  it("ignores ESRCH and propagates other kill errors", () => {
    useDarwin();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    readTable.mockReturnValue([row(11, 10)]);

    expect(cleanUpAntigravityDescendants([{ pid: 11, startTime: row(11, 10).startTime }]))
      .toBe(0);

    kill.mockImplementation(() => {
      throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
    });
    expect(() => cleanUpAntigravityDescendants([
      { pid: 11, startTime: row(11, 10).startTime },
    ])).toThrow("Operation not permitted");
  });

  it("keeps the group SIGKILL and completion when the process table fails", async () => {
    useDarwin();
    readTable.mockImplementation(() => { throw new Error("ps unavailable"); });
    const warn = vi.fn();
    const source = `const emit=x=>console.log(JSON.stringify(x));
      emit({event:'result',result:{status:'SUCCESS',response:'finished'}});
      process.stdout.end(); setInterval(()=>{},1000); setTimeout(()=>process.exit(0),2000);`;
    const child = launchAntigravityProcess({
      executablePath: process.execPath,
      args: ["-e", source],
      cwd: "/tmp",
      env: process.env,
      input: "",
      logger: { warn },
      exitGraceMs: 30,
    });
    for await (const event of child.events) void event;

    const exit = await child.done;
    expect(exit.signal).toBe("SIGKILL");
    expect(exit.forcedAfterResult).toBe(true);
    expect(exit.error).toBe("Antigravity tool descendant cleanup failed");
    expect(warn).toHaveBeenCalledWith(
      { reason: "process_table_unavailable" },
      "Antigravity descendant snapshot unavailable",
    );
  });

  it("still sends the group SIGINT when the process table fails", async () => {
    useDarwin();
    readTable.mockImplementation(() => { throw new Error("ps unavailable"); });
    const warn = vi.fn();
    const source = `const emit=x=>console.log(JSON.stringify(x));
      process.on('SIGINT',()=>emit({event:'result',result:{status:'ERROR',error:'interrupted'}}));
      emit({event:'init',conversation_id:'fixture',init:{model:'fixture'}});
      setInterval(()=>{},1000);`;
    const child = launchAntigravityProcess({
      executablePath: process.execPath,
      args: ["-e", source],
      cwd: "/tmp",
      env: process.env,
      input: "",
      logger: { warn },
      exitGraceMs: 30,
    });
    const events = [];
    for await (const event of child.events) {
      events.push(event);
      if (event.event === "init") expect(child.interrupt()).toBe(true);
    }

    const exit = await child.done;
    expect(events.some((event) => event.result?.error === "interrupted")).toBe(true);
    expect(exit.signal).toBe("SIGKILL");
    expect(child.interrupted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
