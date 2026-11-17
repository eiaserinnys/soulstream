import { setTimeout as sleep } from "node:timers/promises";

export interface HandoverLocks {
  subscribe(receive: (message: string) => void): Promise<void>;
  tryOwner(): Promise<boolean>;
  releaseOwner(): Promise<void>;
  acquirePage(): Promise<void>;
  releasePage(): Promise<void>;
  notify(message: "request" | "ready"): Promise<void>;
  close(): Promise<void>;
}
export interface HandoverActions {
  start(): Promise<void>;
  stopBackground(): Promise<void>;
  resumeBackground(): Promise<void>;
  stopListening(): void;
  drainCommands(): Promise<void>;
  closeNodeSockets(): void;
  closePages(): Promise<void>;
  closeHttp(): Promise<void>;
  exit(): void;
  log(step: string, elapsedMs: number): void;
}
export class OrchestratorHandover {
  private owner = false;
  private stopping = false;
  private handingOver = false;
  private successorReady = false;
  constructor(private readonly locks: HandoverLocks, private readonly actions: HandoverActions,
    private readonly retryMs = 150, private readonly readyTimeoutMs = 15_000) {}
  async start(): Promise<void> {
    const began = Date.now();
    await this.locks.subscribe(message => {
      if (message === "ready" && this.handingOver) this.successorReady = true;
      if (message === "request" && this.owner && !this.handingOver) {
        this.handingOver = true;
        void this.handover().catch(error => { console.error("orchestrator handover failed", error); process.exit(1); });
      }
    });
    let nextRequest = 0;
    while (!this.stopping && !await this.locks.tryOwner()) {
      if (Date.now() >= nextRequest) { await this.locks.notify("request"); nextRequest = Date.now() + 1_000; }
      await sleep(this.retryMs);
    }
    if (this.stopping) return;
    this.owner = true;
    this.actions.log("owner", Date.now() - began);
    await this.actions.start();
    if (this.stopping) return;
    await this.locks.notify("ready");
    const pageStarted = Date.now();
    await this.locks.acquirePage();
    if (!this.stopping) this.actions.log("page_lock", Date.now() - pageStarted);
  }
  cancel(): void { this.stopping = true; }
  async close(): Promise<void> { this.stopping = true; await this.locks.close(); }
  private async handover(): Promise<void> {
    this.actions.log("handover_start", 0);
    await this.step("stop_background", () => this.actions.stopBackground());
    if (this.stopping) return;
    this.owner = false;
    await this.locks.releaseOwner();
    const releasedAt = Date.now();
    while (!this.successorReady && !this.stopping) {
      if (Date.now() - releasedAt >= this.readyTimeoutMs && await this.locks.tryOwner()) {
        this.owner = true;
        await this.actions.resumeBackground();
        this.actions.log("handover_cancelled", Date.now() - releasedAt);
        this.handingOver = false;
        return;
      }
      await sleep(this.retryMs);
    }
    if (this.stopping) return;
    this.actions.stopListening();
    await this.step("pending_commands", () => this.actions.drainCommands());
    if (this.stopping) return;
    this.actions.closeNodeSockets();
    await this.step("pages", () => this.actions.closePages());
    if (this.stopping) return;
    await this.locks.releasePage();
    await this.step("http_and_resources", () => this.actions.closeHttp());
    if (this.stopping) return;
    await this.locks.close();
    if (!this.stopping) this.actions.exit();
  }
  private async step(name: string, action: () => Promise<void>): Promise<void> {
    const began = Date.now();
    try { await action(); } finally { this.actions.log(name, Date.now() - began); }
  }
}
