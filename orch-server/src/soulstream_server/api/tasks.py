"""Task Tree API.

Explicit Task Tree operations share the same PostgreSQL tables as TS MCP tools.
The API exists for dashboard clients; agents should prefer MCP tools.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Literal, Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from soul_common.db.session_db import PostgresSessionDB

TaskStatus = Literal[
    "open",
    "in_progress",
    "agent_done",
    "verified_done",
    "reopened",
    "blocked",
    "cancelled",
]
VerificationOwner = Literal["agent", "user", "both"]


class CreateTaskRequest(BaseModel):
    session_id: str = Field(alias="sessionId")
    title: str
    description: str = ""
    acceptance_criteria: str = Field(default="", alias="acceptanceCriteria")
    verification_owner: VerificationOwner = Field(default="agent", alias="verificationOwner")
    parent_task_id: Optional[str] = Field(default=None, alias="parentTaskId")
    status: TaskStatus = "open"
    set_active: bool = Field(default=False, alias="setActive")
    idempotency_key: Optional[str] = Field(default=None, alias="idempotencyKey")

    model_config = ConfigDict(populate_by_name=True)


class StatusRequest(BaseModel):
    session_id: str = Field(alias="sessionId")
    status: TaskStatus
    reason: Optional[str] = None
    expected_version: Optional[int] = Field(default=None, alias="expectedVersion")
    idempotency_key: Optional[str] = Field(default=None, alias="idempotencyKey")

    model_config = ConfigDict(populate_by_name=True)


class MoveRequest(BaseModel):
    session_id: str = Field(alias="sessionId")
    new_parent_task_id: Optional[str] = Field(default=None, alias="newParentTaskId")
    position_key: Optional[float] = Field(default=None, alias="positionKey")
    reason: Optional[str] = None
    expected_version: Optional[int] = Field(default=None, alias="expectedVersion")
    idempotency_key: Optional[str] = Field(default=None, alias="idempotencyKey")

    model_config = ConfigDict(populate_by_name=True)


class LinkRequest(BaseModel):
    session_id: str = Field(alias="sessionId")
    linked_session_id: str = Field(alias="linkedSessionId")
    linked_node_id: Optional[str] = Field(default=None, alias="linkedNodeId")
    navigation_event_id: Optional[int] = Field(default=None, alias="navigationEventId")
    reason: Optional[str] = None
    expected_version: Optional[int] = Field(default=None, alias="expectedVersion")

    model_config = ConfigDict(populate_by_name=True)


class ArchiveRequest(BaseModel):
    session_id: str = Field(alias="sessionId")
    reason: Optional[str] = None
    expected_version: Optional[int] = Field(default=None, alias="expectedVersion")

    model_config = ConfigDict(populate_by_name=True)


def create_tasks_router(
    db: PostgresSessionDB,
    *,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/tasks",
        tags=["tasks"],
        dependencies=dependencies or [],
    )

    @router.get("")
    async def list_tasks(
        query: Optional[str] = Query(None),
        status: Optional[TaskStatus] = Query(None),
        rootTaskId: Optional[str] = Query(None),
        linkedSessionId: Optional[str] = Query(None),
        includeArchived: bool = Query(False),
        limit: int = Query(500, ge=1, le=1000),
    ) -> dict[str, Any]:
        rows = await _list_tasks(
            db,
            query=query,
            status=status,
            root_task_id=rootTaskId,
            linked_session_id=linkedSessionId,
            include_archived=includeArchived,
            limit=limit,
        )
        return {"tasks": [_serialize_task(row) for row in rows]}

    @router.get("/context")
    async def get_task_context(sessionId: str = Query(...)) -> dict[str, Any]:
        active = await db.pool.fetchrow(
            """
            SELECT * FROM task_items
            WHERE active_for_session_id = $1
              AND archived = FALSE
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            sessionId,
        )
        path = await _task_path(db, active["id"]) if active else []
        linked = await _list_tasks(
            db,
            linked_session_id=sessionId,
            include_archived=False,
            limit=100,
        )
        return {
            "activeTask": _serialize_task(active) if active else None,
            "activeTaskPath": [_serialize_task(row) for row in path],
            "linkedTasks": [_serialize_task(row) for row in linked],
        }

    @router.post("", status_code=201)
    async def create_task(body: CreateTaskRequest) -> dict[str, Any]:
        existing = await _idempotent_result(db, body.idempotency_key)
        if existing:
            return existing

        position_key = await _next_position_key(db, body.parent_task_id)
        task_id = str(uuid4())
        if body.set_active:
            await db.pool.execute(
                """
                UPDATE task_items
                SET active_for_session_id = NULL,
                    updated_at = NOW(),
                    version = version + 1
                WHERE active_for_session_id = $1
                """,
                body.session_id,
            )
        task = await db.pool.fetchrow(
            """
            INSERT INTO task_items (
                id, parent_id, position_key, title, description,
                acceptance_criteria, verification_owner, status,
                active_for_session_id, created_from_session_id,
                navigation_session_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
            RETURNING *
            """,
            task_id,
            body.parent_task_id,
            position_key,
            body.title,
            body.description,
            body.acceptance_criteria,
            body.verification_owner,
            body.status,
            body.session_id if body.set_active else None,
            body.session_id,
        )
        operation, event_id = await _record_operation(
            db,
            actor_session_id=body.session_id,
            task=task,
            operation_type="create_task_item",
            payload={"title": body.title, "parent_task_id": body.parent_task_id},
            idempotency_key=body.idempotency_key,
        )
        task = await _patch_task(
            db,
            task_id,
            {
                "created_from_event_id": event_id,
                "navigation_event_id": event_id,
            },
        )
        return _mutation_response(task, operation, event_id)

    @router.post("/{task_id}/status")
    async def set_status(task_id: str, body: StatusRequest) -> dict[str, Any]:
        existing = await _idempotent_result(db, body.idempotency_key)
        if existing:
            return existing
        task = await _patch_task(
            db,
            task_id,
            {"status": body.status},
            expected_version=body.expected_version,
        )
        operation, event_id = await _record_operation(
            db,
            actor_session_id=body.session_id,
            task=task,
            operation_type="set_task_status",
            payload={"status": body.status},
            reason=body.reason,
            idempotency_key=body.idempotency_key,
        )
        task = await _patch_task(
            db,
            task_id,
            {
                "navigation_session_id": body.session_id,
                "navigation_event_id": event_id,
            },
        )
        return _mutation_response(task, operation, event_id)

    @router.post("/{task_id}/move")
    async def move_task(task_id: str, body: MoveRequest) -> dict[str, Any]:
        existing = await _idempotent_result(db, body.idempotency_key)
        if existing:
            return existing
        if await _would_create_cycle(db, task_id, body.new_parent_task_id):
            raise HTTPException(status_code=422, detail="task tree cycle is not allowed")
        position_key = body.position_key
        if position_key is None:
            position_key = await _next_position_key(db, body.new_parent_task_id)
        task = await _patch_task(
            db,
            task_id,
            {
                "parent_id": body.new_parent_task_id,
                "position_key": position_key,
            },
            expected_version=body.expected_version,
        )
        operation, event_id = await _record_operation(
            db,
            actor_session_id=body.session_id,
            task=task,
            operation_type="move_task_item",
            payload={
                "new_parent_task_id": body.new_parent_task_id,
                "position_key": position_key,
            },
            reason=body.reason,
            idempotency_key=body.idempotency_key,
        )
        task = await _patch_task(
            db,
            task_id,
            {
                "navigation_session_id": body.session_id,
                "navigation_event_id": event_id,
            },
        )
        return _mutation_response(task, operation, event_id)

    @router.post("/{task_id}/link")
    async def link_task(task_id: str, body: LinkRequest) -> dict[str, Any]:
        task = await _patch_task(
            db,
            task_id,
            {
                "linked_session_id": body.linked_session_id,
                "linked_node_id": body.linked_node_id,
                "navigation_session_id": body.linked_session_id,
                "navigation_node_id": body.linked_node_id,
                "navigation_event_id": body.navigation_event_id,
            },
            expected_version=body.expected_version,
        )
        operation, event_id = await _record_operation(
            db,
            actor_session_id=body.session_id,
            task=task,
            operation_type="link_task_session",
            payload={
                "linked_session_id": body.linked_session_id,
                "linked_node_id": body.linked_node_id,
                "navigation_event_id": body.navigation_event_id,
            },
            reason=body.reason,
        )
        if body.navigation_event_id is None:
            task = await _patch_task(
                db,
                task_id,
                {
                    "navigation_session_id": body.session_id,
                    "navigation_event_id": event_id,
                },
            )
        return _mutation_response(task, operation, event_id)

    @router.post("/{task_id}/archive")
    async def archive_task(task_id: str, body: ArchiveRequest) -> dict[str, Any]:
        task = await _patch_task(
            db,
            task_id,
            {
                "archived": True,
                "active_for_session_id": None,
            },
            expected_version=body.expected_version,
        )
        operation, event_id = await _record_operation(
            db,
            actor_session_id=body.session_id,
            task=task,
            operation_type="archive_task_item",
            payload={"archived": True},
            reason=body.reason,
        )
        task = await _patch_task(
            db,
            task_id,
            {
                "navigation_session_id": body.session_id,
                "navigation_event_id": event_id,
            },
        )
        return _mutation_response(task, operation, event_id)

    @router.get("/{task_id}/operations")
    async def list_operations(
        task_id: str,
        limit: int = Query(50, ge=1, le=200),
    ) -> dict[str, Any]:
        rows = await db.pool.fetch(
            """
            SELECT * FROM task_operations
            WHERE task_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            task_id,
            limit,
        )
        return {"operations": [_serialize_operation(row) for row in rows]}

    return router


async def _list_tasks(
    db: PostgresSessionDB,
    *,
    query: str | None = None,
    status: TaskStatus | None = None,
    root_task_id: str | None = None,
    linked_session_id: str | None = None,
    include_archived: bool = False,
    limit: int = 500,
):
    like = f"%{query.strip()}%" if query and query.strip() else None
    if root_task_id:
        return await db.pool.fetch(
            """
            WITH RECURSIVE subtree AS (
                SELECT * FROM task_items WHERE id = $1
                UNION ALL
                SELECT child.*
                FROM task_items child
                JOIN subtree parent ON child.parent_id = parent.id
            )
            SELECT * FROM subtree
            WHERE ($2::boolean OR archived = FALSE)
              AND ($3::text IS NULL OR status = $3)
              AND ($4::text IS NULL OR linked_session_id = $4)
              AND (
                $5::text IS NULL
                OR title ILIKE $5
                OR description ILIKE $5
                OR acceptance_criteria ILIKE $5
              )
            ORDER BY parent_id NULLS FIRST, position_key ASC, created_at ASC
            LIMIT $6
            """,
            root_task_id,
            include_archived,
            status,
            linked_session_id,
            like,
            limit,
        )
    return await db.pool.fetch(
        """
        SELECT * FROM task_items
        WHERE ($1::boolean OR archived = FALSE)
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR linked_session_id = $3)
          AND (
            $4::text IS NULL
            OR title ILIKE $4
            OR description ILIKE $4
            OR acceptance_criteria ILIKE $4
          )
        ORDER BY parent_id NULLS FIRST, position_key ASC, created_at ASC
        LIMIT $5
        """,
        include_archived,
        status,
        linked_session_id,
        like,
        limit,
    )


async def _task_path(db: PostgresSessionDB, task_id: str):
    return await db.pool.fetch(
        """
        WITH RECURSIVE ancestors AS (
            SELECT *, 0 AS depth FROM task_items WHERE id = $1
            UNION ALL
            SELECT parent.*, child.depth + 1
            FROM task_items parent
            JOIN ancestors child ON child.parent_id = parent.id
        )
        SELECT id, parent_id, position_key, title, description,
               acceptance_criteria, verification_owner, status,
               linked_session_id, linked_node_id, active_for_session_id,
               created_from_session_id, created_from_event_id,
               navigation_session_id, navigation_node_id, navigation_event_id,
               archived, version, created_at, updated_at
        FROM ancestors
        ORDER BY depth DESC
        """,
        task_id,
    )


async def _next_position_key(db: PostgresSessionDB, parent_task_id: str | None) -> float:
    value = await db.pool.fetchval(
        """
        SELECT COALESCE(MAX(position_key), 0) + 1
        FROM task_items
        WHERE (($1::text IS NULL AND parent_id IS NULL) OR parent_id = $1)
        """,
        parent_task_id,
    )
    return float(value or 1)


async def _would_create_cycle(
    db: PostgresSessionDB,
    task_id: str,
    candidate_parent_id: str | None,
) -> bool:
    if candidate_parent_id is None:
        return False
    if task_id == candidate_parent_id:
        return True
    return bool(await db.pool.fetchval(
        """
        WITH RECURSIVE descendants AS (
            SELECT id FROM task_items WHERE parent_id = $1
            UNION ALL
            SELECT child.id
            FROM task_items child
            JOIN descendants d ON child.parent_id = d.id
        )
        SELECT EXISTS (SELECT 1 FROM descendants WHERE id = $2)
        """,
        task_id,
        candidate_parent_id,
    ))


async def _idempotent_result(
    db: PostgresSessionDB,
    idempotency_key: str | None,
) -> dict[str, Any] | None:
    if not idempotency_key:
        return None
    operation = await db.pool.fetchrow(
        "SELECT * FROM task_operations WHERE idempotency_key = $1 LIMIT 1",
        idempotency_key,
    )
    if not operation:
        return None
    task = None
    if operation["task_id"]:
        task = await db.pool.fetchrow(
            "SELECT * FROM task_items WHERE id = $1",
            operation["task_id"],
        )
    return {
        "task": _serialize_task(task) if task else None,
        "operation": _serialize_operation(operation),
        "eventId": operation["actor_event_id"],
        "idempotent": True,
    }


async def _record_operation(
    db: PostgresSessionDB,
    *,
    actor_session_id: str,
    task,
    operation_type: str,
    payload: dict[str, Any],
    reason: str | None = None,
    idempotency_key: str | None = None,
):
    operation_id = str(uuid4())
    operation = await db.pool.fetchrow(
        """
        INSERT INTO task_operations (
            id, task_id, operation_type, actor_session_id,
            idempotency_key, payload_json, reason
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        RETURNING *
        """,
        operation_id,
        task["id"] if task else None,
        operation_type,
        actor_session_id,
        idempotency_key,
        json.dumps(payload, ensure_ascii=False),
        reason,
    )
    event_id = await db.append_event(
        actor_session_id,
        "task_operation",
        json.dumps(
            {
                "operation_id": operation_id,
                "operation_type": operation_type,
                "task_id": task["id"] if task else None,
                "task": _serialize_task(task) if task else None,
                "payload": payload,
                "reason": reason,
            },
            ensure_ascii=False,
        ),
        f"task operation {operation_type} {task['title'] if task else ''}".strip(),
        datetime.now(timezone.utc).isoformat(),
    )
    operation = await db.pool.fetchrow(
        "UPDATE task_operations SET actor_event_id = $1 WHERE id = $2 RETURNING *",
        event_id,
        operation_id,
    )
    return operation, int(event_id)


async def _patch_task(
    db: PostgresSessionDB,
    task_id: str,
    fields: dict[str, Any],
    *,
    expected_version: int | None = None,
):
    clean = {key: value for key, value in fields.items()}
    if not clean:
        task = await db.pool.fetchrow("SELECT * FROM task_items WHERE id = $1", task_id)
        if not task:
            raise HTTPException(status_code=404, detail="task item not found")
        return task

    assignments = ", ".join(f"{key} = ${index + 3}" for index, key in enumerate(clean))
    values = list(clean.values())
    row = await db.pool.fetchrow(
        f"""
        UPDATE task_items
        SET {assignments},
            updated_at = NOW(),
            version = version + 1
        WHERE id = $1
          AND ($2::integer IS NULL OR version = $2)
        RETURNING *
        """,
        task_id,
        expected_version,
        *values,
    )
    if not row:
        raise HTTPException(status_code=409, detail="task item not found or version mismatch")
    return row


def _mutation_response(task, operation, event_id: int) -> dict[str, Any]:
    return {
        "task": _serialize_task(task),
        "operation": _serialize_operation(operation),
        "eventId": event_id,
    }


def _serialize_task(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "parentId": row["parent_id"],
        "positionKey": row["position_key"],
        "title": row["title"],
        "description": row["description"],
        "acceptanceCriteria": row["acceptance_criteria"],
        "verificationOwner": row["verification_owner"],
        "status": row["status"],
        "linkedSessionId": row["linked_session_id"],
        "linkedNodeId": row["linked_node_id"],
        "activeForSessionId": row["active_for_session_id"],
        "createdFromSessionId": row["created_from_session_id"],
        "createdFromEventId": row["created_from_event_id"],
        "navigationSessionId": row["navigation_session_id"],
        "navigationNodeId": row["navigation_node_id"],
        "navigationEventId": row["navigation_event_id"],
        "archived": row["archived"],
        "version": row["version"],
        "createdAt": _iso(row["created_at"]),
        "updatedAt": _iso(row["updated_at"]),
    }


def _serialize_operation(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "taskId": row["task_id"],
        "operationType": row["operation_type"],
        "actorKind": row["actor_kind"],
        "actorSessionId": row["actor_session_id"],
        "actorEventId": row["actor_event_id"],
        "actorUserId": row["actor_user_id"],
        "idempotencyKey": row["idempotency_key"],
        "payload": row["payload_json"] or {},
        "reason": row["reason"],
        "createdAt": _iso(row["created_at"]),
    }


def _iso(value) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)
