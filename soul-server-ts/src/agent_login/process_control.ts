import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

import { commandShellSpawn } from "@soulstream/executable-path";

import type { ChildExit } from "../claude_accounts/login_cli_helpers.js";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 자기 프로세스 그룹으로 띄운다. 끝낼 때 그룹 전체를 끝내려는 것이다. */
export function spawnInOwnGroup(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const target = commandShellSpawn(command, args);
  return spawn(target.command, target.args, {
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...target.options,
  });
}

/**
 * pty 안에서 도는 자식(script 아래 agy)은 script가 새 세션으로 옮겨 우리 그룹 밖에 있다.
 * 그래서 /proc의 부모 관계로 자손을 따로 모아 같이 끝낸다. Linux가 아니면 빈 목록이다.
 */
export function collectDescendantPids(rootPid: number): number[] {
  const children = new Map<number, number[]>();
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const parent = Number(fields[1]);
        if (!Number.isInteger(parent)) continue;
        const list = children.get(parent) ?? [];
        list.push(Number(entry));
        children.set(parent, list);
      } catch {
        // 그 사이에 끝난 프로세스다.
      }
    }
  } catch {
    return [];
  }
  const found: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalTree(rootPid: number | undefined, descendants: number[], signal: NodeJS.Signals): void {
  if (rootPid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(rootPid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => {});
    } catch {
      // 이미 끝났다.
    }
    return;
  }
  // 그룹 리더가 아닌 자식은 -rootPid가 ESRCH라 본체에 따로 보내야 한다.
  for (const target of [-rootPid, rootPid, ...descendants]) {
    try {
      process.kill(target, signal);
    } catch {
      // 이미 끝난 프로세스다.
    }
  }
}

async function raceWithTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * stdin을 닫고 그룹 전체와 자손에 SIGTERM, 유예 뒤 남은 것에 SIGKILL을 보낸다.
 * 자식이 먼저 끝나 있어도 그룹과 자손에 남은 것이 있으면 끝낸다.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  exitPromise: Promise<ChildExit>,
  killGracePeriodMs: number,
  postKillWaitMs: number,
): Promise<void> {
  try {
    child.stdin?.end();
    child.stdin?.destroy();
  } catch {
    // 이미 닫혔다.
  }
  const pid = child.pid;
  const descendants = pid === undefined ? [] : collectDescendantPids(pid);
  signalTree(pid, descendants, "SIGTERM");
  const exited = await raceWithTimeout(exitPromise, killGracePeriodMs);
  const survivors = descendants.filter(isProcessAlive);
  if (!exited || survivors.length > 0) {
    signalTree(pid, survivors, "SIGKILL");
    await raceWithTimeout(exitPromise, postKillWaitMs);
  }
}
