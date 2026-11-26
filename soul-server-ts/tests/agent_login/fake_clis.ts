import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { resolveAntigravityCliPath, resolveCodexCliPath } from "@soulstream/executable-path";

import { AgentLoginActivity } from "../../src/agent_login/activity.js";
import { composeAgentLoginService } from "../../src/agent_login/compose.js";
import type { AgentLoginTimings } from "../../src/agent_login/types.js";

/** 시험이 쓰는 일회용 값. 로그에 나타나면 안 된다. */
export const CODEX_URL = "https://auth.openai.com/codex/device";
export const CODEX_USER_CODE = "ABCD-12345";
export const GOOGLE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake-client&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob&response_type=code&scope=openid&state=STATE-SECRET-XYZ";
export const GOOD_CODE = "GOOD-CODE-4/0AbCdEf";
export const BAD_CODE = "BAD-CODE-9/9ZzYy";

export const hasScript = process.platform === "linux" && spawnSync("script", ["--version"]).status === 0;

const FAKE_CODEX = (node: string) => `#!${node}
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
const env = process.env;
const esc = "\\x1b";
appendFileSync(env.FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = env.FAKE_CODEX_MODE ?? "approve";
if (mode === "disabled") {
  process.stderr.write("Error: device code authorization is not enabled for this account. Enable device code in ChatGPT settings.\\n");
  process.exit(1);
}
if (mode === "crash") { process.stderr.write("something broke\\n"); process.exit(3); }
if (mode === "silent") { setInterval(() => {}, 1000); }
else {
  const minutes = env.FAKE_CODEX_EXPIRES ?? "15";
  process.stdout.write([
    "",
    esc + "[1mWelcome to Codex [v0.172.0]" + esc + "[0m",
    esc + "[90mOpenAI's command-line coding agent" + esc + "[0m",
    "Follow these steps to sign in with ChatGPT using device code authorization:",
    "1. Open this link in your browser and sign in to your account",
    "   " + esc + "[94m${CODEX_URL}" + esc + "[0m",
    "2. Enter this one-time code " + esc + "[90m(expires in " + minutes + " minutes)" + esc + "[0m",
    "   " + esc + "[94m${CODEX_USER_CODE}" + esc + "[0m",
    "Device codes are a common phishing target. Never share this code.",
    "",
  ].join("\\n"));
  if (env.FAKE_PIDS_FILE) {
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(env.FAKE_PIDS_FILE, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
  }
  const timer = setInterval(() => {
    if (env.FAKE_CODEX_SIGNAL && existsSync(env.FAKE_CODEX_SIGNAL)) {
      clearInterval(timer);
      if (env.FAKE_CODEX_AUTH_PATH && mode !== "approve_no_auth") {
        mkdirSync(dirname(env.FAKE_CODEX_AUTH_PATH), { recursive: true });
        writeFileSync(env.FAKE_CODEX_AUTH_PATH, JSON.stringify({ tokens: {} }));
      }
      process.exit(0);
    }
  }, 30);
}
`;

const FAKE_AGY = (node: string) => `#!${node}
import { appendFileSync, writeFileSync } from "node:fs";
const env = process.env;
const esc = "\\x1b";
const log = (event) => appendFileSync(env.FAKE_AGY_EVENTS, JSON.stringify(event) + "\\n");
const out = (text) => process.stdout.write(text);
const mode = env.FAKE_AGY_MODE ?? "normal";
const url = env.FAKE_AGY_URL;
writeFileSync(env.FAKE_AGY_PIDS, JSON.stringify({ pid: process.pid, term: env.TERM, isTTY: Boolean(process.stdin.isTTY) }));
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
out(esc + "[?1049h" + esc + "[2J" + esc + "[H" + esc + "[?2004h" + esc + "[c");
setInterval(() => {}, 1000);

function drawUrl() {
  const folded = url.match(/.{1,60}/g).join("\\r\\n");
  out(esc + "[2J" + esc + "[HOpen this URL to sign in:\\r\\n" +
    esc + "]8;;" + url + esc + "\\\\" + esc + "[34m" + folded + esc + "[m" + esc + "]8;;" + esc + "\\\\\\r\\n\\r\\n");
  out(esc + "[1mIf you aren't automatically" + esc + "[1C" + "redirected, paste the authorization code below:" + esc + "[m\\r\\n\\r\\n");
  out(" authorization code...\\r\\n");
}

let phase = "select";
let received = "";
if (mode === "mute") {
  phase = "idle";
} else if (mode === "already") {
  out(esc + "[32mAlready authenticated as test@example.com." + esc + "[0m\\r\\n");
  phase = "idle";
} else {
  out("Select login method:\\r\\n" + esc + "[7m> 1. Google OAuth" + esc + "[m\\r\\n  2. API key\\r\\n");
}
process.stdin.on("data", (data) => {
  if (phase === "select") {
    if (data.includes("\\r")) { log({ event: "selection" }); phase = "paste"; drawUrl(); }
    return;
  }
  if (phase !== "paste") return;
  received += data;
  if (!(received.includes(esc + "[201~") && received.includes("\\r"))) return;
  phase = "done";
  log({ event: "submitted", raw: received });
  const code = received.slice(received.indexOf(esc + "[200~") + 6, received.indexOf(esc + "[201~"));
  out(" " + code + "\\r\\n");
  if (mode === "silent_after_submit") return;
  if (code === env.FAKE_AGY_GOOD_CODE) out(esc + "[32mSuccessfully authenticated." + esc + "[0m\\r\\n");
  else out("Invalid authorization code. Please copy the code again and retry.\\r\\n");
});
`;

export interface Harness {
  root: string;
  codexAuthPath: string;
  codexSignalPath: string;
  codexArgsPath: string;
  pidsPath: string;
  agyEventsPath: string;
  agyPidsPath: string;
  logs: string[];
  usage: { status: "auto" | "error" | "not_configured"; calls: string[] };
  activity: AgentLoginActivity;
  service: ReturnType<typeof composeAgentLoginService>;
  /** 다음에 시작하는 CLI에 넘기는 환경 변수. */
  setEnv(values: Record<string, string>): void;
  agyEvents(): Array<{ event: string; raw?: string }>;
}

export const FAST_TIMINGS: Partial<AgentLoginTimings> = {
  codexOutputWaitMs: 1_500,
  agyOutputWaitMs: 4_000,
  codexExpiryGraceMs: 300,
  agySubmitWatchMs: 600,
  agySuccessSettleMs: 100,
  killGracePeriodMs: 800,
  postKillWaitMs: 800,
  streamDrainWaitMs: 100,
};

export async function createHarness(options: {
  timings?: Partial<AgentLoginTimings>;
  withCodex?: boolean;
  withAgy?: boolean;
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "agent-login-"));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const codexPath = join(bin, "codex.mjs");
  const agyPath = join(bin, "agy.mjs");
  await writeFile(codexPath, FAKE_CODEX(process.execPath));
  await writeFile(agyPath, FAKE_AGY(process.execPath));
  await chmod(codexPath, 0o755);
  await chmod(agyPath, 0o755);
  // PATH에는 가짜 폴더만 둔다. 이 호스트에 실제 codex나 agy가 있어도 시험이 찾지 못한다.
  for (const tool of ["script", "stty"]) {
    const real = ["/usr/bin", "/bin"].map((dir) => join(dir, tool)).find((path) => existsSync(path));
    if (real) await symlink(real, join(bin, tool));
  }

  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const harness = {
    root,
    codexAuthPath: join(home, ".codex", "auth.json"),
    codexSignalPath: join(root, "codex.signal"),
    codexArgsPath: join(root, "codex.args"),
    pidsPath: join(root, "pids.json"),
    agyEventsPath: join(root, "agy.events"),
    agyPidsPath: join(root, "agy.pids"),
  };
  await writeFile(harness.codexArgsPath, "");
  await writeFile(harness.agyEventsPath, "");

  const base: Record<string, string> = {
    FAKE_ARGS_FILE: harness.codexArgsPath,
    FAKE_CODEX_SIGNAL: harness.codexSignalPath,
    FAKE_CODEX_AUTH_PATH: harness.codexAuthPath,
    FAKE_AGY_EVENTS: harness.agyEventsPath,
    FAKE_AGY_PIDS: harness.agyPidsPath,
    FAKE_AGY_URL: GOOGLE_URL,
    FAKE_AGY_GOOD_CODE: GOOD_CODE,
  };
  const logs: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => { logs.push(line); } });
  const usage: Harness["usage"] = { status: "auto", calls: [] };
  const activity = new AgentLoginActivity();
  // 서비스는 시작할 때마다 이 객체에서 HOME, CODEX_HOME, 경로와 FAKE_* 값을 읽어 자식에게 넘긴다.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    ...base,
    PATH: bin,
    AGY_CLI_PATH: options.withAgy === false ? "" : agyPath,
  };
  const setEnv = (values: Record<string, string>) => { Object.assign(env, values); };
  const codexCliPath = options.withCodex === false ? "/nonexistent/codex" : codexPath;
  assertOnlyFakeClis(root, env, codexCliPath);
  const service = composeAgentLoginService({
    logger,
    activity,
    env,
    codexCliPath,
    timings: { ...FAST_TIMINGS, ...options.timings },
    fetchUsage: async (provider) => {
      usage.calls.push(provider);
      return { status: usage.status };
    },
  });
  return {
    ...harness,
    logs,
    usage,
    activity,
    service,
    setEnv,
    agyEvents: () =>
      existsSync(harness.agyEventsPath)
        ? readFileSync(harness.agyEventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
  };
}

/**
 * 서비스가 시작할 때 쓰는 것과 같은 탐색(PATH, HOME 후보, macOS의 /usr/local/bin과 /opt/homebrew/bin)을
 * 서비스를 만들기 전에 한 번 돌려, 이 호스트의 실제 codex나 agy가 잡히면 시험을 멈춘다.
 * 없다고 가정한 CLI(withCodex/withAgy false)는 아무것도 잡히지 않아야 하고, 있는 CLI는 임시 폴더 안이어야 한다.
 */
export function assertOnlyFakeClis(root: string, env: NodeJS.ProcessEnv, codexCliPath: string): void {
  const found = [
    ["codex", resolveCodexCliPath(codexCliPath, env)?.path],
    ["agy", resolveAntigravityCliPath(null, env)?.path],
  ] as const;
  for (const [name, path] of found) {
    if (path !== undefined && !path.startsWith(`${root}/`)) {
      throw new Error(`agent login harness would reach a real ${name} CLI outside the temp dir; refusing to start`);
    }
  }
}

export async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
