/**
 * list_worktrees 페이지 커서. offset과 질의(repo_id, include_removed)를 base64url로
 * 감싼 불투명 문자열이다. 다른 질의에 쓰면 WORKTREE_CURSOR_INVALID로 거절한다.
 */
export interface WorktreeListCursorQuery {
  repoId: string | null;
  includeRemoved: boolean;
}

export interface WorktreeListCursor extends WorktreeListCursorQuery {
  offset: number;
}

export class WorktreeListCursorError extends Error {
  readonly code = "WORKTREE_CURSOR_INVALID";

  constructor(message = "The cursor is not a valid list_worktrees cursor") {
    super(message);
    this.name = "WorktreeListCursorError";
  }
}

export function encodeWorktreeListCursor(cursor: WorktreeListCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.offset, cursor.repoId, cursor.includeRemoved]),
    "utf8",
  ).toString("base64url");
}

export function decodeWorktreeListCursor(cursor: string): WorktreeListCursor {
  let parsed: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (!bytes.length || bytes.toString("base64url") !== cursor) throw new Error("encoding");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new WorktreeListCursorError();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new WorktreeListCursorError();
  const [offset, repoId, includeRemoved] = parsed as unknown[];
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new WorktreeListCursorError();
  }
  if (repoId !== null && typeof repoId !== "string") throw new WorktreeListCursorError();
  if (typeof includeRemoved !== "boolean") throw new WorktreeListCursorError();
  return { offset, repoId, includeRemoved };
}
