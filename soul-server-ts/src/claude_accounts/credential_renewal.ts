import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import {
  buildSanitizedCliEnv,
  resolveClaudeAuthExecutable,
  runClaudeAuthStatusProcess,
  terminateChildProcess,
  type ChildExit,
} from "./login_cli_helpers.js";

export interface ClaudeProfileCredentialRenewer {
  renew(input: { accountId: string; profileDir: string }): Promise<void>;
}

export class ClaudeCliCredentialRenewer implements ClaudeProfileCredentialRenewer {
  private readonly logger: Logger;
  private readonly executablePath?: string;
  private readonly baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** 같은 계정의 동시 갱신 요청은 한 번의 CLI 실행을 함께 기다린다. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: { logger: Logger; executablePath?: string; baseEnv?: NodeJS.ProcessEnv | Record<string, string | undefined> }) {
    this.logger = options.logger;
    this.executablePath = options.executablePath;
    this.baseEnv = options.baseEnv ?? process.env;
  }

  async renew(input: { accountId: string; profileDir: string }): Promise<void> {
    const existing = this.inFlight.get(input.accountId);
    if (existing) return await existing;
    const run = this.runRenew(input).finally(() => {
      this.inFlight.delete(input.accountId);
    });
    this.inFlight.set(input.accountId, run);
    return await run;
  }

  private async runRenew(input: { accountId: string; profileDir: string }): Promise<void> {
    let child: ChildProcess | undefined;
    let exitPromise: Promise<ChildExit> | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child && exitPromise) {
        void terminateChildProcess(child, exitPromise, 2_000).catch(() => {});
      }
    }, 20_000);
    try {
      const status = await runClaudeAuthStatusProcess({
        cli: resolveClaudeAuthExecutable(this.executablePath, this.baseEnv),
        env: buildSanitizedCliEnv(this.baseEnv, input.profileDir),
        onSpawn: (spawned, exited) => { child = spawned; exitPromise = exited; },
      });
      if (!status.loggedIn || timedOut) {
        this.logger.warn({ accountId: input.accountId }, "Claude account credential renewal failed");
      }
    } catch {
      this.logger.warn({ accountId: input.accountId }, "Claude account credential renewal failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
