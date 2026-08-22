import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { waitFor } from "./fault-harness-runtime.mjs";

export async function waitForInFlightTool(runtime, sessionId) {
  return await waitFor(
    async () => {
      const lifecycle = JSON.parse(await readFile(
        join(runtime.runnerDirectory(sessionId), "runner-lifecycle.json"),
        "utf8",
      ));
      return lifecycle.execution_state === "running" && lifecycle.in_flight_tools?.length > 0
        ? lifecycle.in_flight_tools[0]
        : undefined;
    },
    60_000,
    `runner did not enter an in-flight tool for ${sessionId}`,
    100,
  );
}

export async function preserveDeadOwnership(runtime, runnerPid) {
  const pidPath = join(runtime.root, "state", "node.pid");
  const nodePid = Number((await readFile(pidPath, "utf8")).trim());
  const command = (await readFile(`/proc/${nodePid}/cmdline`, "utf8")).replaceAll("\0", " ");
  const entrypoint = join(runtime.repo, "soul-server-ts", "dist", "main.js");
  if (!command.includes(entrypoint)) throw new Error("dead-owner node pid identity mismatch");
  process.kill(nodePid, "SIGSTOP");
  process.kill(runnerPid, "SIGKILL");
  process.kill(nodePid, "SIGKILL");
  await waitFor(
    () => !processIsAlive(nodePid) && !processIsAlive(runnerPid),
    5_000,
    "dead-owner processes did not exit",
    50,
  );
  await unlink(pidPath);
  // This kills the host directly rather than through the runtime, so readiness
  // has to be told that the connection it last saw is gone.
  runtime.expectFreshNodeConnection();
  return nodePid;
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
