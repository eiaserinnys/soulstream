import fs from "node:fs";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { writeFileAtomically } from "@soulstream/atomic-file-rename";

export interface CentralSnapshot<R, P> {
  registry: R;
  profiles: P;
  agent_bindings: Record<string, string>;
}
export type CentralSync = {
  revision: number;
  runtime: unknown;
  display: unknown;
};

export function isPortableMcpNode(env: Record<string, string | undefined>): boolean {
  return env.PORTABLE_LOCAL_MCP_AUTHORIZATION !== undefined;
}

export function resolveMcpCentralModePath(env: { AGENT_PROFILE_CACHE_PATH: string }): string {
  return path.join(path.dirname(path.resolve(env.AGENT_PROFILE_CACHE_PATH)), "mcp-central-mode.json");
}

export class CentralMcpNotSyncedError extends Error {
  readonly code = "CENTRAL_MCP_CONFIG_NOT_SYNCED";
  constructor() {
    super("CENTRAL_MCP_CONFIG_NOT_SYNCED: central MCP configuration has not been synchronized");
  }
}

export class CentralMcpState<R, P> {
  private centralMode = false;
  private revision = 0;
  private snapshot: { runtime: CentralSnapshot<R, P>; display: CentralSnapshot<R, P> } | null = null;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly modePath: string | undefined,
    private readonly validate: (value: unknown) => CentralSnapshot<R, P>) {
    if (!modePath) return;
    try {
      const marker: unknown = JSON.parse(fs.readFileSync(modePath, "utf8"));
      if (marker && typeof marker === "object" && "central_mode" in marker && "revision" in marker
        && typeof marker.central_mode === "boolean" && typeof marker.revision === "number"
        && Number.isInteger(marker.revision) && marker.revision >= 0) {
        this.centralMode = marker.central_mode;
        this.revision = marker.revision;
      }
    } catch { /* absent or invalid marker means local mode */ }
  }

  status(): { mode: "central" | "local"; revision: number } {
    return { mode: this.centralMode ? "central" : "local", revision: this.revision };
  }

  assertReady(): void {
    if (this.centralMode && !this.snapshot) throw new CentralMcpNotSyncedError();
  }

  current(kind: "runtime" | "display"): CentralSnapshot<R, P> | null {
    this.assertReady();
    return this.centralMode ? this.snapshot![kind] : null;
  }

  async apply(input: CentralSync): Promise<void> {
    if (!Number.isInteger(input.revision) || input.revision < 0) throw new Error("Invalid MCP revision");
    const next = { runtime: this.validate(input.runtime), display: this.validate(input.display) };
    if (this.modePath) {
      await mkdir(path.dirname(this.modePath), { recursive: true });
      await writeFileAtomically(this.modePath, JSON.stringify({ central_mode: true, revision: input.revision }));
    }
    this.centralMode = true;
    this.revision = input.revision;
    this.snapshot = next;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async wait(timeoutMs: number): Promise<void> {
    if (!this.centralMode || this.snapshot) return;
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.add(finish);
    });
  }
}
