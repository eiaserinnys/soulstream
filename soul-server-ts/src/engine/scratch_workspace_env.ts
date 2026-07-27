export const SCRATCH_WORKSPACE_DIR_ENV = "SCRATCH_WORKSPACE_DIR";
export const SOULSTREAM_AGENT_ID_ENV = "SOULSTREAM_AGENT_ID";
export const AGENT_COMMON_FILES_DIR_ENV = "AGENT_COMMON_FILES_DIR";

export function withScratchWorkspaceEnv(
  env: Record<string, string> | undefined,
  params: { workspaceDir: string; agentId?: string },
): Record<string, string> {
  const out: Record<string, string> = { ...(env ?? {}) };
  out[SCRATCH_WORKSPACE_DIR_ENV] = params.workspaceDir;
  if (params.agentId !== undefined && params.agentId.trim().length > 0) {
    out[SOULSTREAM_AGENT_ID_ENV] = params.agentId;
  }
  const commonFilesDir = process.env[AGENT_COMMON_FILES_DIR_ENV];
  delete out[AGENT_COMMON_FILES_DIR_ENV];
  if (commonFilesDir !== undefined && commonFilesDir.trim().length > 0) {
    out[AGENT_COMMON_FILES_DIR_ENV] = commonFilesDir;
  }
  return out;
}
