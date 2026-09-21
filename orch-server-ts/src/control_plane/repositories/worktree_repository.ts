import type { SqlClient } from "../control_plane_types.js";

type WorktreeRow = {
  id: string;
  node_id: string;
  repo_id: string;
  canonical_path: string;
  branch: string;
  created_from_sha: string;
  owner_task_id: string | null;
  created_by_session_id: string;
  state: "ready" | "removing" | "removed";
  setup_mode: "none" | "shared_dependencies";
  setup_required: boolean;
  setup_status: "not_requested" | "ready" | "failed";
  managed_paths: unknown;
  worktree_identity: string;
  branch_delete_expected_sha: string | null;
  branch_delete_marker_ref: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date;
  updated_at: Date;
  removed_at: Date | null;
  branch_deleted_at: Date | null;
};

export type WorktreeBinding = {
  id: string;
  nodeId: string;
  ownerTaskId: string | null;
  createdBySessionId: string;
  state: string;
  setupRequired: boolean;
  setupStatus: string;
};

export class WorktreeRepository {
  constructor(private readonly sql: SqlClient) {}

  async list(input: {
    actorSessionId: string;
    nodeId: string;
    repoId?: string;
    worktreeId?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql<WorktreeRow[]>`
      SELECT w.*
      FROM worktrees w
      WHERE w.node_id = ${input.nodeId}
        AND (${input.repoId ?? null}::TEXT IS NULL OR w.repo_id = ${input.repoId ?? null})
        AND (${input.worktreeId ?? null}::TEXT IS NULL OR w.id = ${input.worktreeId ?? null})
      ORDER BY w.created_at, w.id
    `;
    return await Promise.all(rows.map(async (row) => ({
      ...project(row),
      mutableByCaller: await actorOwns(this.sql, row, input.actorSessionId),
      activeSessionId: await activeSessionId(this.sql, row.id),
    })));
  }

  async register(input: {
    actorSessionId: string;
    id: string;
    nodeId: string;
    repoId: string;
    canonicalPath: string;
    branch: string;
    createdFromSha: string;
    setupMode: "none" | "shared_dependencies";
    setupRequired: boolean;
    setupStatus: "not_requested" | "ready" | "failed";
    managedPaths: unknown[];
    worktreeIdentity: string;
  }): Promise<Record<string, unknown>> {
    if (!input.actorSessionId) throw hostError(422, "actorSessionId is required");
    return await this.sql.begin(async (transaction) => {
      const tx = transaction as unknown as SqlClient;
      const ownerTaskId = await primaryTaskId(tx, input.actorSessionId);
      const rows = await tx<WorktreeRow[]>`
        INSERT INTO worktrees (
          id, node_id, repo_id, canonical_path, branch, created_from_sha,
          owner_task_id, created_by_session_id, setup_mode, setup_required,
          setup_status, managed_paths, worktree_identity
        ) VALUES (
          ${input.id}, ${input.nodeId}, ${input.repoId}, ${input.canonicalPath},
          ${input.branch}, ${input.createdFromSha}, ${ownerTaskId},
          ${input.actorSessionId}, ${input.setupMode}, ${input.setupRequired},
          ${input.setupStatus}, ${tx.json(input.managedPaths as never)},
          ${input.worktreeIdentity}
        )
        RETURNING *
      `;
      return project(rows[0]!);
    });
  }

  async updateSetup(input: {
    actorSessionId: string;
    worktreeId: string;
    setupStatus: "not_requested" | "ready" | "failed";
    managedPaths: unknown[];
  }) {
    return await this.mutateLocked(input, async (tx, row) => {
      if (row.state !== "ready") throw hostError(409, "WORKTREE_UNAVAILABLE");
      const rows = await tx<WorktreeRow[]>`
        UPDATE worktrees SET setup_status = ${input.setupStatus},
          managed_paths = ${tx.json(input.managedPaths as never)},
          updated_at = NOW()
        WHERE id = ${row.id} RETURNING *
      `;
      return rows[0]!;
    });
  }

  async beginRemove(input: {
    actorSessionId: string;
    worktreeId: string;
    expectedSha: string;
  }) {
    return await this.mutateLocked(input, async (tx, row) => {
      if (row.state === "removed") return row;
      if (
        row.branch_delete_expected_sha !== null
        && row.branch_delete_expected_sha !== input.expectedSha
      ) {
        throw hostError(409, "WORKTREE_REMOVAL_HEAD_CHANGED");
      }
      const active = await activeSessionId(tx, row.id);
      if (active) throw hostError(409, `WORKTREE_IN_USE: ${active}`);
      const rows = await tx<WorktreeRow[]>`
        UPDATE worktrees SET state = 'removing', updated_at = NOW(),
          branch_delete_expected_sha = COALESCE(branch_delete_expected_sha, ${input.expectedSha}),
          last_error_code = NULL, last_error_message = NULL
        WHERE id = ${row.id} RETURNING *
      `;
      return rows[0]!;
    });
  }

  async restoreReady(input: {
    actorSessionId: string;
    worktreeId: string;
    errorCode: string;
    errorMessage: string;
  }) {
    return await this.mutateLocked(input, async (tx, row) => {
      if (row.state === "removed") return row;
      const rows = await tx<WorktreeRow[]>`
        UPDATE worktrees SET state = 'ready', updated_at = NOW(),
          last_error_code = ${input.errorCode}, last_error_message = ${input.errorMessage}
        WHERE id = ${row.id} RETURNING *
      `;
      return rows[0]!;
    });
  }

  async finishRemove(input: { actorSessionId: string; worktreeId: string }) {
    return await this.mutateLocked(input, async (tx, row) => {
      if (row.state === "removed") return row;
      if (row.state !== "removing") throw hostError(409, "WORKTREE_NOT_REMOVING");
      const rows = await tx<WorktreeRow[]>`
        UPDATE worktrees SET state = 'removed', removed_at = NOW(), updated_at = NOW(),
          last_error_code = NULL, last_error_message = NULL
        WHERE id = ${row.id} RETURNING *
      `;
      return rows[0]!;
    });
  }

  async beginBranchDelete(input: {
    actorSessionId: string;
    worktreeId: string;
    expectedSha: string;
    markerRef: string;
  }) {
    return await this.mutateLocked(input, async (tx, row) => {
      if (row.state !== "removed") throw hostError(409, "WORKTREE_NOT_REMOVED");
      if (row.branch_deleted_at) return row;
      const rows = await tx<WorktreeRow[]>`
        UPDATE worktrees SET branch_delete_expected_sha = ${input.expectedSha},
          branch_delete_marker_ref = ${input.markerRef}, updated_at = NOW()
        WHERE id = ${row.id} RETURNING *
      `;
      return rows[0]!;
    });
  }

  async finishBranchDelete(input: { actorSessionId: string; worktreeId: string }) {
    return await this.mutateLocked(input, async (tx, row) => {
      if (row.branch_deleted_at) return row;
      if (!row.branch_delete_expected_sha || !row.branch_delete_marker_ref) {
        throw hostError(409, "BRANCH_DELETE_NOT_PREPARED");
      }
      const rows = await tx<WorktreeRow[]>`
        UPDATE worktrees SET branch_deleted_at = NOW(), updated_at = NOW()
        WHERE id = ${row.id} RETURNING *
      `;
      return rows[0]!;
    });
  }

  async resolveExecution(input: { worktreeId: string; nodeId: string }) {
    const rows = await this.sql<WorktreeRow[]>`
      SELECT * FROM worktrees WHERE id = ${input.worktreeId}
    `;
    const row = rows[0];
    if (!row || row.node_id !== input.nodeId || row.state !== "ready") {
      throw hostError(409, "WORKTREE_UNAVAILABLE");
    }
    if (row.setup_required && row.setup_status !== "ready") {
      throw hostError(409, "WORKTREE_SETUP_REQUIRED");
    }
    return project(row);
  }

  private async mutateLocked(
    input: { actorSessionId: string; worktreeId: string },
    mutate: (tx: SqlClient, row: WorktreeRow) => Promise<WorktreeRow>,
  ) {
    if (!input.actorSessionId) throw hostError(422, "actorSessionId is required");
    return await this.sql.begin(async (transaction) => {
      const tx = transaction as unknown as SqlClient;
      const rows = await tx<WorktreeRow[]>`
        SELECT * FROM worktrees WHERE id = ${input.worktreeId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw hostError(404, "WORKTREE_NOT_FOUND");
      if (!await actorOwns(tx, row, input.actorSessionId)) {
        throw hostError(403, "WORKTREE_NOT_OWNED");
      }
      return project(await mutate(tx, row));
    });
  }
}

export async function lockWorktreeForSessionBinding(
  sql: SqlClient,
  input: {
    worktreeId: string;
    nodeId: string;
    actorSessionId: string;
    ownerTaskId: string | null;
  },
): Promise<WorktreeBinding> {
  const rows = await sql<WorktreeRow[]>`
    SELECT * FROM worktrees WHERE id = ${input.worktreeId} FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw hostError(404, "WORKTREE_NOT_FOUND");
  if (row.node_id !== input.nodeId) throw hostError(409, "WORKTREE_NODE_MISMATCH");
  if (row.state !== "ready") throw hostError(409, "WORKTREE_UNAVAILABLE");
  if (row.setup_required && row.setup_status !== "ready") {
    throw hostError(409, "WORKTREE_SETUP_REQUIRED");
  }
  if (row.owner_task_id !== null && row.owner_task_id !== input.ownerTaskId) {
    throw hostError(403, "WORKTREE_TASK_MISMATCH");
  }
  if (!await actorOwns(sql, row, input.actorSessionId)) {
    throw hostError(403, "WORKTREE_NOT_OWNED");
  }
  const active = await activeSessionId(sql, row.id);
  if (active) throw hostError(409, `WORKTREE_IN_USE: ${active}`);
  return {
    id: row.id,
    nodeId: row.node_id,
    ownerTaskId: row.owner_task_id,
    createdBySessionId: row.created_by_session_id,
    state: row.state,
    setupRequired: row.setup_required,
    setupStatus: row.setup_status,
  };
}

async function primaryTaskId(sql: SqlClient, sessionId: string): Promise<string | null> {
  const rows = await sql<Array<{ container_id: string }>>`
    SELECT container_id FROM board_items
    WHERE item_type = 'session' AND item_id = ${sessionId}
      AND membership_kind = 'primary' AND container_kind = 'task'
    ORDER BY created_at LIMIT 1
  `;
  return rows[0]?.container_id ?? null;
}

async function activeSessionId(sql: SqlClient, worktreeId: string): Promise<string | null> {
  const rows = await sql<Array<{ session_id: string }>>`
    SELECT session_id FROM sessions
    WHERE worktree_id = ${worktreeId} AND status IN ('initializing', 'running')
    ORDER BY created_at LIMIT 1
  `;
  return rows[0]?.session_id ?? null;
}

async function actorOwns(sql: SqlClient, row: WorktreeRow, actorSessionId: string): Promise<boolean> {
  if (row.owner_task_id !== null) {
    return await primaryTaskId(sql, actorSessionId) === row.owner_task_id;
  }
  if (row.created_by_session_id === actorSessionId) return true;
  const rows = await sql<Array<{ owned: boolean }>>`
    WITH RECURSIVE lineage(session_id) AS (
      SELECT ${actorSessionId}::TEXT
      UNION
      SELECT sessions.caller_session_id
      FROM sessions JOIN lineage ON sessions.session_id = lineage.session_id
      WHERE sessions.caller_session_id IS NOT NULL
    )
    SELECT EXISTS(
      SELECT 1 FROM lineage WHERE session_id = ${row.created_by_session_id}
    ) AS owned
  `;
  return rows[0]?.owned === true;
}

function project(row: WorktreeRow): Record<string, unknown> {
  return {
    id: row.id,
    nodeId: row.node_id,
    repoId: row.repo_id,
    canonicalPath: row.canonical_path,
    branch: row.branch,
    createdFromSha: row.created_from_sha,
    ownerTaskId: row.owner_task_id,
    createdBySessionId: row.created_by_session_id,
    state: row.state,
    setupMode: row.setup_mode,
    setupRequired: row.setup_required,
    setupStatus: row.setup_status,
    managedPaths: row.managed_paths,
    worktreeIdentity: row.worktree_identity,
    branchDeleteExpectedSha: row.branch_delete_expected_sha,
    branchDeleteMarkerRef: row.branch_delete_marker_ref,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    removedAt: row.removed_at?.toISOString() ?? null,
    branchDeletedAt: row.branch_deleted_at?.toISOString() ?? null,
  };
}

function hostError(
  statusCode: number,
  message: string,
): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), {
    statusCode,
    code: message.split(":", 1)[0]!,
  });
}
