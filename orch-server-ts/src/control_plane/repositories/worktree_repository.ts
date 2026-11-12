import type { SqlClient } from "../control_plane_types.js";

type WorktreeRow = {
  id: string;
  node_id: string;
  repo_id: string;
  canonical_path: string;
  branch: string;
  created_from_sha: string;
  owner_folder_id: string | null;
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
  ownerFolderId: string | null;
  createdBySessionId: string;
  state: string;
  setupRequired: boolean;
  setupStatus: string;
};

type WorktreeListRow = WorktreeRow & {
  active_session_id: string | null;
};

export type WorktreeOwnership = {
  owns: boolean;
  released: boolean;
};

const NO_OWNERSHIP: WorktreeOwnership = { owns: false, released: false };
const RELEASED_IDLE_MS = 24 * 60 * 60 * 1000;

type RemovalActor = { actorSessionId: string; sweeperNodeId?: never }
  | { sweeperNodeId: string; actorSessionId?: never };

export class WorktreeRepository {
  constructor(private readonly sql: SqlClient) {}

  async list(input: {
    actorSessionId: string;
    nodeId: string;
    repoId?: string;
    worktreeId?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql<WorktreeListRow[]>`
      SELECT w.*,
        (
          SELECT session_id FROM sessions
          WHERE worktree_id = w.id AND status IN ('initializing', 'running')
          ORDER BY created_at LIMIT 1
        ) AS active_session_id
      FROM worktrees w
      WHERE w.node_id = ${input.nodeId}
        AND (${input.repoId ?? null}::TEXT IS NULL OR w.repo_id = ${input.repoId ?? null})
        AND (${input.worktreeId ?? null}::TEXT IS NULL OR w.id = ${input.worktreeId ?? null})
      ORDER BY w.created_at, w.id
    `;
    const ownership = await ownershipForWorktrees(this.sql, input.actorSessionId, rows);
    return rows.map((row) => {
      const entry = ownership.get(row.id) ?? NO_OWNERSHIP;
      return {
        ...project(row),
        mutableByCaller: entry.owns,
        removableByCaller: entry.owns || entry.released,
        activeSessionId: row.active_session_id,
      };
    });
  }

  async sweepCandidates(input: { nodeId: string }): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql<Array<WorktreeRow & {
      last_session_activity_at: Date; linked_cards_closed: boolean;
    }>>`
      WITH candidates AS (
        SELECT w.* FROM worktrees w
        WHERE w.node_id = ${input.nodeId} AND w.state = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM sessions active
            WHERE active.worktree_id = w.id AND active.status IN ('initializing', 'running')
          )
      ), linked AS (
        SELECT c.id AS worktree_id, s.session_id, s.updated_at, s.card_id
        FROM candidates c JOIN sessions s ON s.worktree_id = c.id
        UNION
        SELECT c.id, s.session_id, s.updated_at, s.card_id
        FROM candidates c JOIN sessions s ON s.session_id = c.created_by_session_id
      )
      SELECT c.*,
        GREATEST(c.created_at, activity.last_session_activity_at) AS last_session_activity_at,
        COALESCE(activity.linked_cards_closed, false) AS linked_cards_closed
      FROM candidates c
      LEFT JOIN (
        SELECT l.worktree_id, MAX(l.updated_at) AS last_session_activity_at,
          COUNT(cd.id) > 0 AND BOOL_AND(cd.status IN ('done', 'cancelled')) AS linked_cards_closed
        FROM linked l LEFT JOIN cards cd ON cd.id = l.card_id
        GROUP BY l.worktree_id
      ) activity ON activity.worktree_id = c.id
      ORDER BY c.created_at, c.id
    `;
    return rows.map(row => ({ ...project(row),
      lastSessionActivityAt: row.last_session_activity_at.toISOString(),
      linkedCardsClosed: row.linked_cards_closed,
    }));
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
      const ownerFolderId = await primaryFolderId(tx, input.actorSessionId);
      const rows = await tx<WorktreeRow[]>`
        INSERT INTO worktrees (
          id, node_id, repo_id, canonical_path, branch, created_from_sha,
          owner_folder_id, created_by_session_id, setup_mode, setup_required,
          setup_status, managed_paths, worktree_identity
        ) VALUES (
          ${input.id}, ${input.nodeId}, ${input.repoId}, ${input.canonicalPath},
          ${input.branch}, ${input.createdFromSha}, ${ownerFolderId},
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

  async beginRemove(input: RemovalActor & {
    worktreeId: string;
    expectedSha: string | null;
  }) {
    if (!input.expectedSha && !("sweeperNodeId" in input)) throw hostError(422, "expectedSha is required");
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
    }, true, true);
  }

  async restoreReady(input: RemovalActor & {
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
    }, true, true);
  }

  async finishRemove(input: RemovalActor & { worktreeId: string }) {
    return await this.mutateLocked(input, async (tx, row) => {
      if (row.state === "removed") return row;
      if (row.state !== "removing") throw hostError(409, "WORKTREE_NOT_REMOVING");
      const rows = await tx<WorktreeRow[]>`
        UPDATE worktrees SET state = 'removed', removed_at = NOW(), updated_at = NOW(),
          last_error_code = NULL, last_error_message = NULL
        WHERE id = ${row.id} RETURNING *
      `;
      return rows[0]!;
    }, true, true);
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
    }, false, true);
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
    }, false, true);
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
    input: RemovalActor & { worktreeId: string },
    mutate: (tx: SqlClient, row: WorktreeRow) => Promise<WorktreeRow>,
    allowSweeper = false,
    removal = false,
  ) {
    const sweeper = "sweeperNodeId" in input;
    if (sweeper ? !allowSweeper || !input.sweeperNodeId || Boolean(input.actorSessionId) : !input.actorSessionId) {
      throw hostError(422, "Exactly one permitted worktree actor is required");
    }
    return await this.sql.begin(async (transaction) => {
      const tx = transaction as unknown as SqlClient;
      const rows = await tx<WorktreeRow[]>`
        SELECT * FROM worktrees WHERE id = ${input.worktreeId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw hostError(404, "WORKTREE_NOT_FOUND");
      if (sweeper) {
        if (row.node_id !== input.sweeperNodeId) throw hostError(403, "WORKTREE_NODE_MISMATCH");
      } else {
        const ownership = (await ownershipForWorktrees(tx, input.actorSessionId!, [row]))
          .get(row.id) ?? NO_OWNERSHIP;
        const allowed = removal ? ownership.owns || ownership.released : ownership.owns;
        if (!allowed) throw hostError(403, "WORKTREE_NOT_OWNED");
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
    ownerFolderId: string | null;
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
  if (row.owner_folder_id !== null && row.owner_folder_id !== input.ownerFolderId) {
    throw hostError(403, "WORKTREE_FOLDER_MISMATCH");
  }
  const ownership = (await ownershipForWorktrees(sql, input.actorSessionId, [row]))
    .get(row.id) ?? NO_OWNERSHIP;
  if (!ownership.owns) throw hostError(403, "WORKTREE_NOT_OWNED");
  const active = await activeSessionId(sql, row.id);
  if (active) throw hostError(409, `WORKTREE_IN_USE: ${active}`);
  return {
    id: row.id,
    nodeId: row.node_id,
    ownerFolderId: row.owner_folder_id,
    createdBySessionId: row.created_by_session_id,
    state: row.state,
    setupRequired: row.setup_required,
    setupStatus: row.setup_status,
  };
}

async function primaryFolderId(sql: SqlClient, sessionId: string): Promise<string | null> {
  const rows = await sql<Array<{ folder_id: string | null }>>`
    SELECT folder_id FROM sessions WHERE session_id = ${sessionId}
  `;
  return rows[0]?.folder_id ?? null;
}

async function activeSessionId(sql: SqlClient, worktreeId: string): Promise<string | null> {
  const rows = await sql<Array<{ session_id: string }>>`
    SELECT session_id FROM sessions
    WHERE worktree_id = ${worktreeId} AND status IN ('initializing', 'running')
    ORDER BY created_at LIMIT 1
  `;
  return rows[0]?.session_id ?? null;
}

type CreatorState = {
  cardId: string | null;
  status: string;
  updatedAt: Date;
};

type CallerContext = {
  lineage: Set<string>;
  lineageCardIds: Set<string>;
};

type CallerContextRow = { kind: "session" | "card"; id: string };

/**
 * 워크트리 소유 판정의 유일한 자리(카드 #1276).
 *
 * - 카드 C = 만든 세션의 sessions.card_id(카드 행이 없으면 카드 없는 것으로 본다).
 * - 소유: C가 있으면 C가 호출 세션 계보의 카드 집합에 들 때만, 없으면 호출 세션이
 *   생성자이거나 생성자가 계보의 조상일 때만. 폴더는 보지 않는다.
 * - 소유 해제: C의 status가 done/cancelled이거나, 카드가 없고 생성자 세션이 없거나
 *   initializing/running이 아니면서 24시간 넘게 조용할 때. 해제는 지우기와 브랜치
 *   삭제에만 쓰고 붙이기와 mutableByCaller에는 쓰지 않는다.
 */
export function decideWorktreeOwnership(input: {
  actorSessionId: string;
  lineage: ReadonlySet<string>;
  lineageCardIds: ReadonlySet<string>;
  createdBySessionId: string;
  creator: CreatorState | null;
  cardStatus: string | null;
  nowMs: number;
}): WorktreeOwnership {
  const cardId = input.creator?.cardId ?? null;
  if (cardId !== null && input.cardStatus !== null) {
    return {
      owns: input.lineageCardIds.has(cardId),
      released: input.cardStatus === "done" || input.cardStatus === "cancelled",
    };
  }
  return {
    owns: input.createdBySessionId === input.actorSessionId
      || input.lineage.has(input.createdBySessionId),
    released: input.creator === null
      || (input.creator.status !== "initializing"
        && input.creator.status !== "running"
        && input.nowMs - input.creator.updatedAt.getTime() > RELEASED_IDLE_MS),
  };
}

async function ownershipForWorktrees(
  sql: SqlClient,
  actorSessionId: string,
  worktrees: ReadonlyArray<Pick<WorktreeRow, "id" | "created_by_session_id">>,
  nowMs = Date.now(),
): Promise<Map<string, WorktreeOwnership>> {
  const result = new Map<string, WorktreeOwnership>();
  if (worktrees.length === 0) return result;
  const caller = await loadCallerContext(sql, actorSessionId);
  const creators = await loadCreatorStates(sql, worktrees.map((worktree) => worktree.created_by_session_id));
  const cardIds = [...creators.values()]
    .map((creator) => creator.cardId)
    .filter((cardId): cardId is string => cardId !== null);
  const cardStatuses = await loadCardStatuses(sql, cardIds);
  for (const worktree of worktrees) {
    const creator = creators.get(worktree.created_by_session_id) ?? null;
    const cardId = creator?.cardId ?? null;
    result.set(worktree.id, decideWorktreeOwnership({
      actorSessionId,
      lineage: caller.lineage,
      lineageCardIds: caller.lineageCardIds,
      createdBySessionId: worktree.created_by_session_id,
      creator,
      cardStatus: cardId === null ? null : (cardStatuses.get(cardId) ?? null),
      nowMs,
    }));
  }
  return result;
}

async function loadCallerContext(sql: SqlClient, actorSessionId: string): Promise<CallerContext> {
  const rows = await sql<CallerContextRow[]>`
    WITH RECURSIVE lineage(session_id) AS (
      SELECT ${actorSessionId}::TEXT
      UNION
      SELECT sessions.caller_session_id
      FROM sessions JOIN lineage ON sessions.session_id = lineage.session_id
      WHERE sessions.caller_session_id IS NOT NULL
    )
    SELECT 'session' AS kind, l.session_id AS id
    FROM lineage l
    UNION ALL
    SELECT 'card' AS kind, s.card_id AS id
    FROM sessions s JOIN lineage l ON l.session_id = s.session_id
    WHERE s.card_id IS NOT NULL
    UNION ALL
    SELECT 'card' AS kind, c.id AS id
    FROM cards c JOIN lineage l ON l.session_id = c.assignee_session_id
  `;
  const lineage = new Set<string>();
  const lineageCardIds = new Set<string>();
  for (const row of rows) {
    if (row.kind === "session") lineage.add(row.id);
    else lineageCardIds.add(row.id);
  }
  return { lineage, lineageCardIds };
}

async function loadCreatorStates(
  sql: SqlClient,
  sessionIds: readonly string[],
): Promise<Map<string, CreatorState>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Map();
  const rows = await sql<Array<{
    session_id: string;
    card_id: string | null;
    status: string;
    updated_at: Date;
  }>>`
    SELECT session_id, card_id, status, updated_at
    FROM sessions
    WHERE session_id = ANY(${ids}::TEXT[])
  `;
  return new Map(rows.map((row) => [row.session_id, {
    cardId: row.card_id,
    status: row.status,
    updatedAt: row.updated_at,
  }]));
}

async function loadCardStatuses(
  sql: SqlClient,
  cardIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(cardIds)];
  if (ids.length === 0) return new Map();
  const rows = await sql<Array<{ id: string; status: string }>>`
    SELECT id, status FROM cards WHERE id = ANY(${ids}::TEXT[])
  `;
  return new Map(rows.map((row) => [row.id, row.status]));
}

function project(row: WorktreeRow): Record<string, unknown> {
  return {
    id: row.id,
    nodeId: row.node_id,
    repoId: row.repo_id,
    canonicalPath: row.canonical_path,
    branch: row.branch,
    createdFromSha: row.created_from_sha,
    ownerFolderId: row.owner_folder_id,
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
