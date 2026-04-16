"""LLM completions 프록시 라우터 (/api/llm/completions)"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from soul_server.dashboard.auth import require_dashboard_auth

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post(
    "/api/llm/completions",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_llm_completions(request: Request):
    """LLM completions 프록시 (soul-server 내장 LLM executor 경유)"""
    llm_executor = getattr(request.app.state, "llm_executor", None)
    if llm_executor is None:
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "code": "LLM_NOT_CONFIGURED",
                    "message": "LLM executor가 초기화되지 않았습니다. LLM API 키를 설정하세요.",
                }
            },
        )

    from soul_server.models.llm import LlmCompletionRequest

    body = await request.json()
    try:
        llm_request = LlmCompletionRequest(**body)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "INVALID_REQUEST", "message": str(e)}},
        )

    try:
        result = await llm_executor.execute(llm_request)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "PROVIDER_NOT_CONFIGURED", "message": str(e)}},
        )
    except Exception as e:
        logger.exception(f"LLM completion error: {e}")
        raise HTTPException(
            status_code=502,
            detail={"error": {"code": "LLM_API_ERROR", "message": "LLM API call failed"}},
        )
