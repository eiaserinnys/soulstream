"""GET /api/status — 노드 가동 상태 + 실행 중인 task + 러너 풀 통계."""

from fastapi import APIRouter, Depends, Request

from soul_server.dashboard.auth import require_dashboard_auth
from soul_server.service import resource_manager
from soul_server.service.session_query_service import get_session_query_service
from soul_server.service.task_manager import get_task_manager

router = APIRouter()


@router.get("/api/status", dependencies=[Depends(require_dashboard_auth)])
async def api_status(request: Request):
    task_manager = get_task_manager()
    running_tasks = get_session_query_service().get_running_tasks()

    response: dict = {
        "active_tasks": len(running_tasks),
        "max_concurrent": resource_manager.max_concurrent,
        "is_draining": getattr(request.app.state, "is_draining", False),
        "tasks": [
            {
                "client_id": t.client_id,
                "agent_session_id": t.agent_session_id,
                "status": t.status,
                "created_at": t.created_at.isoformat(),
            }
            for t in running_tasks
        ],
    }

    runner_pool = getattr(request.app.state, "runner_pool", None)
    if runner_pool is not None:
        response["runner_pool"] = runner_pool.stats()

    return response
