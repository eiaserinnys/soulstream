"""PostgresTaskMixin — 업무 조회 투영 (PostgreSQL)"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    import asyncpg


def _normalize_task_row(row: dict) -> dict:
    result = dict(row)
    for key in ("created_at", "updated_at", "completed_at"):
        value = result.get(key)
        if hasattr(value, "isoformat"):
            result[key] = value.isoformat()
    return result


def _normalize_task_overview_item(row: dict) -> dict:
    result = _normalize_task_row(row)
    if "item_version" in result:
        result["item_version"] = int(result["item_version"])
    return result


def _normalize_task_overview_group(row: dict, items: list[dict]) -> dict:
    result = _normalize_task_row(row)
    if "task_version" in result:
        result["task_version"] = int(result["task_version"])
    result["completed_count"] = int(result.get("completed_count") or 0)
    result["total_count"] = int(result.get("total_count") or 0)
    result["items"] = items
    return result


class PostgresTaskMixin:
    """업무 overview/read projection.

    Mixin이므로 self._pool은 PostgresSessionDB.__init__에서 설정된다.
    """

    _pool: asyncpg.Pool

    async def list_my_turn_items(
        self,
        user_id: Optional[str] = None,
        limit: int = 100,
    ) -> list[dict]:
        safe_limit = min(max(int(limit), 1), 500)
        rows = await self._pool.fetch(
            """
            SELECT
                r.id AS task_id,
                r.title AS task_title,
                r.status AS task_status,
                r.board_item_id,
                bi.folder_id,
                r.completed_kind AS task_completed_kind,
                r.completed_session_id AS task_completed_session_id,
                r.completed_event_id AS task_completed_event_id,
                r.completed_user_id AS task_completed_user_id,
                r.completed_at AS task_completed_at,
                s.id AS section_id,
                s.title AS section_title,
                i.id AS item_id,
                i.title AS item_title,
                i.how_to,
                i.status,
                i.version AS item_version,
                r.created_session_id AS task_created_session_id,
                s.created_session_id AS section_created_session_id,
                s.updated_session_id AS section_updated_session_id,
                i.created_session_id AS item_created_session_id,
                i.updated_session_id AS item_updated_session_id,
                COALESCE(i.assignee_kind, s.assignee_kind) AS effective_assignee_kind,
                CASE WHEN i.assignee_kind IS NULL THEN s.assignee_agent_id ELSE i.assignee_agent_id END AS effective_assignee_agent_id,
                CASE WHEN i.assignee_kind IS NULL THEN s.assignee_session_id ELSE i.assignee_session_id END AS effective_assignee_session_id,
                CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END AS effective_assignee_user_id
            FROM task_items i
            JOIN task_sections s ON s.id = i.section_id
            JOIN tasks r ON r.id = s.task_id
            JOIN board_items bi ON bi.id = r.board_item_id
            WHERE r.archived = FALSE
              AND r.status <> 'completed'
              AND s.archived = FALSE
              AND i.archived = FALSE
              AND (
                i.status = 'review'
                OR (
                  i.status NOT IN ('completed', 'cancelled')
                  AND COALESCE(i.assignee_kind, s.assignee_kind) = 'human'
                  AND (
                    $1::text IS NULL
                    OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) IS NULL
                    OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) = $1
                  )
                )
              )
            ORDER BY
                CASE
                  WHEN i.status = 'review' THEN 0
                  WHEN i.status = 'in_progress' THEN 1
                  ELSE 2
                END,
                r.updated_at DESC,
                s.position_key ASC,
                i.position_key ASC
            LIMIT $2
            """,
            user_id,
            safe_limit,
        )
        return [_normalize_task_overview_item(dict(row)) for row in rows]

    async def get_task_overview(
        self,
        user_id: Optional[str] = None,
        limit: int = 100,
    ) -> dict:
        my_turn_items = await self.list_my_turn_items(user_id=user_id, limit=limit)
        group_rows = await self._pool.fetch(
            """
            SELECT
                r.id AS task_id,
                r.title AS task_title,
                r.version AS task_version,
                r.status AS task_status,
                r.board_item_id,
                bi.folder_id,
                r.completed_kind AS task_completed_kind,
                r.completed_session_id AS task_completed_session_id,
                r.completed_event_id AS task_completed_event_id,
                r.completed_user_id AS task_completed_user_id,
                r.completed_at AS task_completed_at,
                r.updated_at,
                COUNT(*) FILTER (WHERE i.status = 'completed') AS completed_count,
                COUNT(*) AS total_count,
                COUNT(*) FILTER (
                    WHERE r.status <> 'completed'
                      AND (
                        i.status = 'review'
                        OR (
                          i.status <> 'completed'
                          AND COALESCE(i.assignee_kind, s.assignee_kind) = 'human'
                          AND (
                            $1::text IS NULL
                            OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) IS NULL
                            OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) = $1
                          )
                        )
                      )
                ) AS my_turn_count,
                COUNT(*) FILTER (WHERE i.status = 'in_progress') AS in_progress_count
            FROM tasks r
            JOIN board_items bi ON bi.id = r.board_item_id
            JOIN task_sections s ON s.task_id = r.id
            JOIN task_items i ON i.section_id = s.id
            WHERE r.archived = FALSE
              AND s.archived = FALSE
              AND i.archived = FALSE
              AND i.status <> 'cancelled'
            GROUP BY
                r.id,
                r.title,
                r.version,
                r.status,
                r.board_item_id,
                bi.folder_id,
                r.completed_kind,
                r.completed_session_id,
                r.completed_event_id,
                r.completed_user_id,
                r.completed_at,
                r.updated_at
            ORDER BY my_turn_count DESC, in_progress_count DESC, r.updated_at DESC
            """,
            user_id,
        )
        item_rows = await self._pool.fetch(
            """
            SELECT
                r.id AS task_id,
                r.title AS task_title,
                r.status AS task_status,
                r.board_item_id,
                bi.folder_id,
                r.completed_kind AS task_completed_kind,
                r.completed_session_id AS task_completed_session_id,
                r.completed_event_id AS task_completed_event_id,
                r.completed_user_id AS task_completed_user_id,
                r.completed_at AS task_completed_at,
                s.id AS section_id,
                s.title AS section_title,
                i.id AS item_id,
                i.title AS item_title,
                i.how_to,
                i.status,
                i.version AS item_version,
                r.created_session_id AS task_created_session_id,
                s.created_session_id AS section_created_session_id,
                s.updated_session_id AS section_updated_session_id,
                i.created_session_id AS item_created_session_id,
                i.updated_session_id AS item_updated_session_id,
                COALESCE(i.assignee_kind, s.assignee_kind) AS effective_assignee_kind,
                CASE WHEN i.assignee_kind IS NULL THEN s.assignee_agent_id ELSE i.assignee_agent_id END AS effective_assignee_agent_id,
                CASE WHEN i.assignee_kind IS NULL THEN s.assignee_session_id ELSE i.assignee_session_id END AS effective_assignee_session_id,
                CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END AS effective_assignee_user_id
            FROM tasks r
            JOIN board_items bi ON bi.id = r.board_item_id
            JOIN task_sections s ON s.task_id = r.id
            JOIN task_items i ON i.section_id = s.id
            WHERE r.archived = FALSE
              AND s.archived = FALSE
              AND i.archived = FALSE
              AND i.status <> 'cancelled'
            ORDER BY
                r.updated_at DESC,
                CASE i.status
                    WHEN 'review' THEN 0
                    WHEN 'in_progress' THEN 1
                    WHEN 'pending' THEN 2
                    WHEN 'completed' THEN 3
                    ELSE 4
                END,
                s.position_key ASC,
                i.position_key ASC
            """,
        )
        items_by_task: dict[str, list[dict]] = {}
        for row in item_rows:
            item = _normalize_task_overview_item(dict(row))
            items_by_task.setdefault(item["task_id"], []).append(item)
        tasks: list[dict[str, Any]] = []
        for row in group_rows:
            data = dict(row)
            tasks.append(
                _normalize_task_overview_group(
                    data,
                    items_by_task.get(data["task_id"], []),
                ),
            )
        return {
            "my_turn_items": my_turn_items,
            "tasks": tasks,
        }
