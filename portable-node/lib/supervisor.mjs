import { spawn } from "node:child_process";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * 자식 프로세스 하나만 띄워 감독한다.
 * - 예상 밖 종료: 3초 뒤 다시 띄운다.
 * - Ctrl+C/SIGTERM: 자식에게만 신호를 보낸다. 프로세스 그룹을 죽이지 않는다(러너 보호).
 */
export class ChildSupervisor {
  constructor({
    command,
    args = [],
    cwd,
    env,
    readyWindowMs = 10000,
    restartDelayMs = 3000,
    shutdownGraceMs = 20000,
    log = () => {},
    stdio = "inherit",
  }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.readyWindowMs = readyWindowMs;
    this.restartDelayMs = restartDelayMs;
    this.shutdownGraceMs = shutdownGraceMs;
    this.log = log;
    this.stdio = stdio;
    this.child = null;
    this.stopping = false;
    this.stoppedBy = null;
    this.restarts = 0;
    this.signalHandler = null;
  }

  spawnChild() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: this.stdio,
      windowsHide: false,
      detached: false,
    });
    return this.child;
  }

  async start() {
    const child = this.spawnChild();
    const exitPromise = waitExit(child);
    let timer;
    const ready = await Promise.race([
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ready: true }), this.readyWindowMs);
      }),
      exitPromise.then((exit) => ({ ready: false, exit })),
    ]);
    clearTimeout(timer);
    if (!ready.ready) {
      return { started: false, exit: ready.exit };
    }
    this.pendingExit = exitPromise;
    return { started: true };
  }

  async stop(reason = "signal") {
    if (this.stopping) return;
    this.stopping = true;
    this.stoppedBy = reason;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.log("자식에게 종료 신호를 보냅니다…");
    child.kill("SIGTERM");
    const exitPromise = this.pendingExit ?? waitExit(child);
    const finished = await Promise.race([
      exitPromise.then(() => true),
      delay(this.shutdownGraceMs).then(() => false),
    ]);
    if (!finished) {
      this.log("정해진 시간 안에 끝나지 않아 자식만 강제 종료합니다.");
      child.kill("SIGKILL");
      await exitPromise;
    }
  }

  /** 감독 루프. stop()이 불릴 때까지 예상 밖 종료를 다시 띄운다. */
  async run() {
    this.signalHandler = () => {
      this.stop("signal").catch(() => {});
    };
    process.on("SIGINT", this.signalHandler);
    process.on("SIGTERM", this.signalHandler);
    try {
      let exit = await (this.pendingExit ?? waitExit(this.child));
      while (!this.stopping) {
        this.log(`자식이 끝났습니다 (code=${exit.code}, signal=${exit.signal}). ${this.restartDelayMs}ms 뒤 다시 띄웁니다.`);
        await delay(this.restartDelayMs);
        if (this.stopping) break;
        this.restarts += 1;
        const child = this.spawnChild();
        exit = await waitExit(child);
      }
      return { stoppedBy: this.stoppedBy ?? "stop", restarts: this.restarts };
    } finally {
      process.removeListener("SIGINT", this.signalHandler);
      process.removeListener("SIGTERM", this.signalHandler);
      this.signalHandler = null;
    }
  }
}
