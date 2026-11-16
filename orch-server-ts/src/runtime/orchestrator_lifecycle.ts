import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";

const BUILD_ID_PATTERN = /^[a-f0-9]{40}$/;

async function readBuildIdFile(path: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path, "utf8"),
  ) as { build_id?: unknown };
  if (
    typeof manifest.build_id !== "string" ||
    !BUILD_ID_PATTERN.test(manifest.build_id)
  )
    throw new Error("Invalid dashboard build-info.json build_id");
  return manifest.build_id;
}

export async function readDashboardBuildId(
  dashboardDir: string,
  environment: string,
): Promise<string> {
  if (environment !== "production") return "dev";
  return await readBuildIdFile(join(dashboardDir, "build-info.json"));
}

/**
 * The deployed dashboard build identity. `processBuildId` is the commit the
 * running process started with; `currentBuildId()` follows build-info.json on
 * disk so a deploy that only rebuilds artifacts does not leave health and node
 * release delivery on the previous commit once this process stays up.
 */
export class DashboardBuildInfo {
  private lastGoodBuildId: string;
  private lastMtimeMs: number | undefined;

  private constructor(
    readonly processBuildId: string,
    private readonly path: string | null,
  ) {
    this.lastGoodBuildId = processBuildId;
  }

  /** A fixed identity that never re-reads the disk. */
  static fixed(buildId: string): DashboardBuildInfo {
    return new DashboardBuildInfo(buildId, null);
  }

  static async open(
    dashboardDir: string,
    environment: string,
  ): Promise<DashboardBuildInfo> {
    if (environment !== "production") {
      return new DashboardBuildInfo("dev", null);
    }
    const path = join(dashboardDir, "build-info.json");
    // Startup keeps failing closed: a missing or invalid manifest stops the boot.
    const buildId = await readBuildIdFile(path);
    const info = new DashboardBuildInfo(buildId, path);
    try {
      info.lastMtimeMs = (await stat(path)).mtimeMs;
    } catch {
      // The read above succeeded; a racing stat failure only forces the next read.
    }
    return info;
  }

  async currentBuildId(): Promise<string> {
    const path = this.path;
    if (path === null) return this.lastGoodBuildId;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      return this.lastGoodBuildId;
    }
    if (mtimeMs === this.lastMtimeMs) return this.lastGoodBuildId;
    // Record the mtime before reading so a broken file is retried only when it
    // changes again, and a failed read never replaces the last good identity.
    this.lastMtimeMs = mtimeMs;
    try {
      this.lastGoodBuildId = await readBuildIdFile(path);
    } catch {
      // A partial write or a bad deploy keeps the identity already served.
    }
    return this.lastGoodBuildId;
  }
}

/** Readiness and shutdown identity have one owner for health and the SSE notice. */
export class OrchestratorLifecycle {
  private ready = false;
  private draining = false;
  private readonly buildInfo: DashboardBuildInfo;
  constructor(
    // A bare string keeps the fixed-id callers outside production (the
    // dashboard connection harness) working: that id never re-reads disk.
    buildInfo: DashboardBuildInfo | string,
    private readonly broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
  ) {
    this.buildInfo =
      typeof buildInfo === "string" ? DashboardBuildInfo.fixed(buildInfo) : buildInfo;
  }
  markReady(): void {
    if (!this.draining) this.ready = true;
  }
  async snapshot() {
    return {
      healthy: this.ready && !this.draining,
      ready: this.ready && !this.draining,
      draining: this.draining,
      instance_id: this.broadcaster.instanceId,
      build_id: await this.buildInfo.currentBuildId(),
      process_build_id: this.buildInfo.processBuildId,
    };
  }
  async beginShutdown(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.broadcaster.append({
      type: "orchestrator_shutdown",
      ...(await this.snapshot()),
    });
    await this.broadcaster.flush();
  }
}
