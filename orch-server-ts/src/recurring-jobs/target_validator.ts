import {
  isBoardFolderAllowed,
  normalizeBoardAccess,
  type BoardAccessFolderRecord,
} from "../board/board_access.js";
import {
  ModelPresetAvailabilityError,
  type ModelPresetAvailabilityService,
} from "../model/model_preset_availability.js";
import { InMemoryNodeRegistry } from "../node/registry.js";
import {
  selectNodeForSessionCreate,
  SessionCreateNodeSelectionError,
} from "../session/session_create_node_selector.js";
import type { DashboardUserRepository } from "../runtime/live_dashboard_access_provider.js";

import { RecurringJobError, type RecurringJob, type RecurringJobActor } from "./types.js";

type RecurringJobTarget = Pick<
  RecurringJob,
  "nodeId" | "agentId" | "modelPreset" | "folderId"
>;

export type RecurringJobTargetValidatorOptions = {
  readonly registry: InMemoryNodeRegistry;
  readonly modelPresetAvailability: Pick<ModelPresetAvailabilityService, "requireAvailable">;
  readonly listFolders: () =>
    | readonly (BoardAccessFolderRecord & { archived?: boolean })[]
    | Promise<readonly (BoardAccessFolderRecord & { archived?: boolean })[]>;
  readonly findUserByEmail: DashboardUserRepository["findUserByEmail"];
};

export type RecurringJobTargetValidationInput = {
  readonly actor: RecurringJobActor;
  readonly target: RecurringJobTarget;
  /** Skip only live node/model selection for a retained persisted target. */
  readonly requireAvailableTarget?: boolean;
};

/**
 * Shared, server-side target gate for browser, soul-app, and trusted MCP host
 * calls. The actor comes from the authenticated route or verified caller
 * session; never from a job payload owner field.
 */
export function createRecurringJobTargetValidator(
  options: RecurringJobTargetValidatorOptions,
): (input: RecurringJobTargetValidationInput) => Promise<void> {
  return async ({ actor, target, requireAvailableTarget = true }) => {
    if (requireAvailableTarget) {
      try {
        const selection = selectNodeForSessionCreate(options.registry, {
          nodeId: target.nodeId,
          profileId: target.agentId,
          ...(target.modelPreset === null ? {} : { modelPresetId: target.modelPreset }),
        });
        if (selection.modelPresetId) {
          options.modelPresetAvailability.requireAvailable(selection.node.nodeId, selection.modelPresetId);
        }
      } catch (error) {
        throw targetSelectionError(error);
      }
    }

    const folders = await options.listFolders();
    if (!folders.some((folder) => folder.id === target.folderId)) {
      throw new RecurringJobError("NOT_FOUND", "Target folder was not found.", 404);
    }
    if (folders.find(folder => folder.id === target.folderId)?.archived === true) {
      throw new RecurringJobError("ARCHIVED", "Target folder is archived.", 409);
    }
    const user = await options.findUserByEmail(actor.ownerEmail);
    const access = normalizeBoardAccess(
      user === null
        ? { restricted: true, allowedFolderIds: [] }
        : user.isAdmin || user.allowedFolderIds.length === 0
          ? { restricted: false }
          : { restricted: true, allowedFolderIds: user.allowedFolderIds },
    );
    if (!isBoardFolderAllowed(access, folders, target.folderId)) {
      throw new RecurringJobError("FORBIDDEN", "Target folder access is not allowed.", 403);
    }


  };
}

function targetSelectionError(error: unknown): RecurringJobError {
  if (error instanceof SessionCreateNodeSelectionError) {
    const code = error.code === "NO_AVAILABLE_NODE" ? "NODE_UNAVAILABLE" : "VALIDATION";
    return new RecurringJobError(code, error.message, error.statusCode);
  }
  if (error instanceof ModelPresetAvailabilityError) {
    return new RecurringJobError("VALIDATION", error.message, error.statusCode);
  }
  return new RecurringJobError(
    "VALIDATION",
    error instanceof Error ? error.message : "Recurring job target is invalid.",
    422,
  );
}
