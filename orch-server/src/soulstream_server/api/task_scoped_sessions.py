"""Task-scoped New Session helpers."""

from __future__ import annotations

from dataclasses import dataclass
import logging
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from soul_common.db.session_db import PostgresSessionDB
from soulstream_server.api.tasks import (
    _idempotent_result,
    _mutation_response,
    _next_position_key,
    _patch_task,
    _record_operation,
    _serialize_task,
)

TASK_PARENT_CONTEXT_KEY = "task_tree_parent"
DEFAULT_CHILD_TASK_TITLE = "하위 대화"
MAX_CHILD_TASK_TITLE_LENGTH = 80


@dataclass
class TaskScopedSessionRequest:
    existing_response: dict[str, Any] | None
    parent_task: Any | None
    extra_context_items: list[dict[str, str]]


async def prepare_task_scoped_session_request(
    db: PostgresSessionDB,
    *,
    parent_task_id: str | None,
    idempotency_key: str | None,
) -> TaskScopedSessionRequest:
    existing = await get_existing_task_scoped_session(
        db,
        idempotency_key if parent_task_id else None,
    )
    if existing:
        return TaskScopedSessionRequest(existing_task_scoped_session_response(existing), None, [])
    if not parent_task_id:
        return TaskScopedSessionRequest(None, None, [])
    parent_task = await get_task_or_404(db, parent_task_id)
    return TaskScopedSessionRequest(
        None,
        parent_task,
        [build_parent_task_context_item(parent_task)],
    )


async def task_scoped_response_fields(
    db: PostgresSessionDB,
    *,
    parent_task,
    child_session_id: str,
    child_node_id: str | None,
    prompt: str,
    idempotency_key: str | None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    if not parent_task:
        return {}
    try:
        task_result = await create_task_scoped_child(
            db,
            parent_task=parent_task,
            child_session_id=child_session_id,
            child_node_id=child_node_id,
            prompt=prompt,
            idempotency_key=idempotency_key,
        )
        return {
            "task": task_result["task"],
            "taskOperation": task_result["operation"],
            "taskEventId": task_result["eventId"],
        }
    except Exception as err:
        if logger:
            logger.exception(
                "Task-scoped session created but child task link failed: parentTaskId=%s sessionId=%s",
                parent_task["id"],
                child_session_id,
            )
        return {"taskLinkError": task_link_error_payload(err)}


async def get_task_or_404(db: PostgresSessionDB, task_id: str):
    task = await db.pool.fetchrow(
        "SELECT * FROM task_items WHERE id = $1 AND archived = FALSE",
        task_id,
    )
    if not task:
        raise HTTPException(status_code=404, detail="parent task item not found")
    return task


async def get_existing_task_scoped_session(
    db: PostgresSessionDB,
    idempotency_key: str | None,
) -> dict[str, Any] | None:
    existing = await _idempotent_result(db, idempotency_key)
    if not existing or not existing.get("task"):
        return None

    task = existing["task"]
    linked_session_id = task.get("linkedSessionId")
    if not linked_session_id:
        return None
    return {
        "agentSessionId": linked_session_id,
        "nodeId": task.get("linkedNodeId"),
        "task": task,
        "operation": existing.get("operation"),
        "eventId": existing.get("eventId"),
        "idempotent": True,
    }


def existing_task_scoped_session_response(existing: dict[str, Any]) -> dict[str, Any]:
    return {
        "agentSessionId": existing["agentSessionId"],
        "nodeId": existing.get("nodeId"),
        "task": existing["task"],
        "taskOperation": existing.get("operation"),
        "taskEventId": existing.get("eventId"),
        "idempotent": True,
    }


def build_parent_task_context_item(parent_task) -> dict[str, str]:
    parent = _serialize_task(parent_task)
    content = "\n".join(
        [
            "Task Tree parent context.",
            "This is a normal user-started New Session scoped under the parent task, not a delegated agent task.",
            "",
            f"- id: {parent['id']}",
            f"- title: {parent['title']}",
            f"- status: {parent['status']}",
            f"- description: {parent['description'] or '(empty)'}",
            f"- acceptanceCriteria: {parent['acceptanceCriteria'] or '(empty)'}",
        ]
    )
    return {
        "key": TASK_PARENT_CONTEXT_KEY,
        "label": "Task Tree parent",
        "content": content,
    }


async def create_task_scoped_child(
    db: PostgresSessionDB,
    *,
    parent_task,
    child_session_id: str,
    child_node_id: str | None,
    prompt: str,
    idempotency_key: str | None,
) -> dict[str, Any]:
    existing = await get_existing_task_scoped_session(db, idempotency_key)
    if existing:
        return existing

    actor_session_id = (
        parent_task["navigation_session_id"]
        or parent_task["linked_session_id"]
        or parent_task["created_from_session_id"]
        or child_session_id
    )
    position_key = await _next_position_key(db, parent_task["id"])
    task_id = str(uuid4())
    title = _child_title_from_prompt(prompt)
    task = await db.pool.fetchrow(
        """
        INSERT INTO task_items (
            id, parent_id, position_key, title, description,
            acceptance_criteria, verification_owner, status,
            linked_session_id, linked_node_id,
            active_for_session_id, created_from_session_id,
            navigation_session_id, navigation_node_id, navigation_event_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
        """,
        task_id,
        parent_task["id"],
        position_key,
        title,
        "",
        "",
        "both",
        "in_progress",
        child_session_id,
        child_node_id,
        child_session_id,
        actor_session_id,
        child_session_id,
        child_node_id,
        None,
    )
    operation, event_id = await _record_operation(
        db,
        actor_session_id=actor_session_id,
        task=task,
        operation_type="start_child_session",
        payload={
            "parent_task_id": parent_task["id"],
            "linked_session_id": child_session_id,
            "linked_node_id": child_node_id,
            "title": title,
            "status": "in_progress",
        },
        idempotency_key=idempotency_key,
    )
    task = await _patch_task(
        db,
        task_id,
        {"created_from_event_id": event_id},
    )
    return await _mutation_response(db, task, operation, event_id)


def task_link_error_payload(err: Exception) -> dict[str, Any]:
    return {
        "message": str(err),
        "type": err.__class__.__name__,
    }


def _child_title_from_prompt(prompt: str) -> str:
    first_line = next((line.strip() for line in prompt.splitlines() if line.strip()), "")
    if not first_line:
        return DEFAULT_CHILD_TASK_TITLE
    if len(first_line) <= MAX_CHILD_TASK_TITLE_LENGTH:
        return first_line
    return first_line[: MAX_CHILD_TASK_TITLE_LENGTH - 1].rstrip() + "…"
