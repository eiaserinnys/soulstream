import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TASKKILL_TIMEOUT_MS = 2_000;

export async function terminateWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync(
    "taskkill",
    ["/PID", String(pid), "/T", "/F"],
    { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true },
  );
}
