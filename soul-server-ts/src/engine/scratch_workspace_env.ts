import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCRATCH_WORKSPACE_DIR_ENV = "SCRATCH_WORKSPACE_DIR";
export const SOULSTREAM_AGENT_ID_ENV = "SOULSTREAM_AGENT_ID";

export function withScratchWorkspaceEnv(
  env: Record<string, string> | undefined,
  params: { workspaceDir: string; agentId?: string },
): Record<string, string> {
  const out: Record<string, string> = { ...(env ?? {}) };
  out[SCRATCH_WORKSPACE_DIR_ENV] = params.workspaceDir;
  if (params.agentId !== undefined && params.agentId.trim().length > 0) {
    out[SOULSTREAM_AGENT_ID_ENV] = params.agentId;
  }
  return out;
}

export function writeScratchAgentMarker(params: {
  workspaceDir: string;
  agentId: string;
}): void {
  const workspaceDir = params.workspaceDir;
  const agentId = params.agentId.trim();
  if (agentId.length === 0) {
    throw new Error("writeScratchAgentMarker: agentId must not be empty");
  }
  if (!statSync(workspaceDir).isDirectory()) {
    throw new Error(`writeScratchAgentMarker: workspaceDir is not a directory: ${workspaceDir}`);
  }

  const localDir = join(workspaceDir, ".local");
  const markerPath = join(localDir, ".agent_marker");
  mkdirSync(localDir, { recursive: true });

  if (existsSync(markerPath)) {
    const existing = readFileSync(markerPath, "utf8").trim();
    if (existing.length > 0 && existing !== agentId) {
      throw new Error(
        `Scratch workspace marker mismatch: ${workspaceDir} belongs to ${existing}, not ${agentId}`,
      );
    }
  }

  writeFileSync(markerPath, `${agentId}\n`, "utf8");
}
