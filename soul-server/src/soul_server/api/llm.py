"""
LLM API - LLM 프록시 엔드포인트

외부 서비스가 LLM API를 호출할 수 있는 프록시 엔드포인트를 제공합니다.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException

from soul_server.api.auth import verify_token
from soul_server.models.llm import LlmCompletionRequest, LlmCompletionResponse
from soul_server.llm.executor import LlmExecutor

logger = logging.getLogger(__name__)


def create_llm_router(executor: LlmExecutor) -> APIRouter:
    """LLM 라우터 생성

    Args:
        executor: LLM 실행 서비스 인스턴스

    Returns:
        설정된 APIRouter
    """
    router = APIRouter(prefix="/llm", tags=["llm"])

    @router.post(
        "/completions",
        response_model=LlmCompletionResponse,
        dependencies=[Depends(verify_token)],
    )
    async def create_completion(
        request: LlmCompletionRequest,
    ) -> LlmCompletionResponse:
        """LLM 완성 요청

        OpenAI/Anthropic API를 프록시하여 호출합니다.
        호출 이력이 세션으로 추적됩니다.
        """
        try:
            return await executor.execute(request)
        except ValueError as e:
            # 미설정 프로바이더
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "PROVIDER_NOT_CONFIGURED",
                        "message": str(e),
                        "details": {},
                    }
                },
            )
        except Exception as e:
            logger.exception(f"LLM completion error: {e}")
            # 프로덕션에서는 내부 에러 메시지 노출 방지
            from soul_server.config import get_settings
            message = (
                "LLM API call failed"
                if get_settings().is_production
                else f"LLM API call failed: {e}"
            )
            raise HTTPException(
                status_code=502,
                detail={
                    "error": {
                        "code": "LLM_API_ERROR",
                        "message": message,
                        "details": {},
                    }
                },
            )

    return router
