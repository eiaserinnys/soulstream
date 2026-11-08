import { execFileSync } from "node:child_process";

export interface DarwinProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly status: string;
  readonly startTime: string;
}

// lstart is localized by the host unless LC_ALL is fixed. Keep the C locale
// shape so the start time can be compared with the snapshot taken at SIGINT.
const LSTART_PATTERN = new RegExp(
  "^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) "
    + "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) "
    + "(\\d{1,2}) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$",
  "u",
);

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const READ_TIMEOUT_MS = 2000;

/** Parse `ps -ax -o pid=,ppid=,stat=,lstart=` output and drop unusable rows. */
export function parseDarwinProcessTable(output: string): DarwinProcessRow[] {
  const rows: DarwinProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const status = match[3]!;
    const startTime = match[4]!.replace(/\s+/gu, " ");
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (!Number.isSafeInteger(ppid) || ppid < 0) continue;
    const start = LSTART_PATTERN.exec(startTime);
    if (!start) continue;
    const day = Number(start[3]);
    const hour = Number(start[4]);
    const minute = Number(start[5]);
    const second = Number(start[6]);
    if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) continue;
    rows.push({ pid, ppid, status, startTime });
  }
  return rows;
}

/** Read the macOS process table without depending on /proc or localized text. */
export function readDarwinProcessTable(): DarwinProcessRow[] {
  const output = execFileSync("/bin/ps", ["-ax", "-o", "pid=,ppid=,stat=,lstart="], {
    encoding: "utf8",
    timeout: READ_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  return parseDarwinProcessTable(output);
}
