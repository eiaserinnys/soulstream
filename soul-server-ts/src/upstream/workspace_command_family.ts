import type { WorkspaceFileRead, WorkspaceFileDiff, WorkspaceSnapshot } from "@soulstream/wire-schema";
import type { WorkspaceService } from "../workspace/workspace_service.js";
import { CommandDispatchError, commandRequestId, type CommandHandlerMap, type SendFn } from "./command_family.js";

export function createWorkspaceCommandFamily(deps: {send: SendFn; workspace: WorkspaceService}): CommandHandlerMap {
  return {
    workspace_snapshot: async raw => {
      const cmd = raw as WorkspaceSnapshot;
      try { await deps.send({ type: "workspace_snapshot_result", requestId: commandRequestId(raw), ...await deps.workspace.snapshot(cmd, cmd.since) }); }
      catch (error) { throw new CommandDispatchError(error instanceof Error ? error.message : String(error)); }
    },
    workspace_file_diff: async raw => {
      const cmd = raw as WorkspaceFileDiff;
      try { await deps.send({ type: "workspace_file_diff_result", requestId: commandRequestId(raw), ...await deps.workspace.diff(cmd, cmd.path, cmd.orig_path) }); }
      catch (error) { throw new CommandDispatchError(error instanceof Error ? error.message : String(error)); }
    },
    workspace_file_read: async raw => {
      const cmd = raw as WorkspaceFileRead;
      try { await deps.send({ type: "workspace_file_read_result", requestId: commandRequestId(raw), ...await deps.workspace.read(cmd, cmd.path, cmd.offset, cmd.length) }); }
      catch (error) { throw new CommandDispatchError(error instanceof Error ? error.message : String(error)); }
    },
  };
}
