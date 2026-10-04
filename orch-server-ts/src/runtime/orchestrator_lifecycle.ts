import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";

export async function readDashboardBuildId(
  dashboardDir: string,
  environment: string,
): Promise<string> {
  if (environment !== "production") return "dev";
  const manifest = JSON.parse(
    await readFile(join(dashboardDir, "build-info.json"), "utf8"),
  ) as { build_id?: unknown };
  if (
    typeof manifest.build_id !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.build_id)
  )
    throw new Error("Invalid dashboard build-info.json build_id");
  return manifest.build_id;
}

/** Readiness and shutdown identity have one owner for health and the SSE notice. */
export class OrchestratorLifecycle {
  private ready = false;
  private draining = false;
  constructor(
    readonly buildId: string,
    private readonly broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
  ) {}
  markReady(): void {
    if (!this.draining) this.ready = true;
  }
  snapshot() {
    return {
      healthy: this.ready && !this.draining,
      ready: this.ready && !this.draining,
      draining: this.draining,
      instance_id: this.broadcaster.instanceId,
      build_id: this.buildId,
    };
  }
  async beginShutdown(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.broadcaster.append({
      type: "orchestrator_shutdown",
      ...this.snapshot(),
    });
    await this.broadcaster.flush();
  }
}
