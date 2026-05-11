"""
LLM Proxy - Pydantic 스키마

LLM 프록시 API의 요청/응답 모델을 정의합니다.
"""

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class LlmMessage(BaseModel):
    """LLM 메시지"""
    role: Literal["system", "user", "assistant"]
    content: str


class LlmCompletionRequest(BaseModel):
    """LLM 완성 요청"""
    provider: Literal["openai", "anthropic"]
    model: str
    messages: list[LlmMessage]
    max_tokens: int = Field(default=2048, ge=1)
    temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0)
    client_id: Optional[str] = Field(
        default=None,
        description="호출자 식별 (ex. 'translate', 'recall')",
    )
    # R-3 (atom G-6, 2026-05-11): caller_info 통합 v1 스키마 (atom ed3a216d). 외부 호출자가
    # 자기 source를 박으면 그대로 wire/DB에 영속. None이면 LlmExecutor가 build_system_caller_info
    # fallback으로 system 정체성 자동 부여 — 감사·추적·디버깅 가시성 보장.
    caller_info: Optional[dict[str, Any]] = Field(
        default=None,
        description=(
            "발신자 신원 (통합 v1 스키마, atom ed3a216d). 외부 호출자가 자기 source를 박으면 "
            "그대로 영속·표시. 안 박으면 LlmExecutor가 build_system_caller_info fallback — "
            "wire/DB에 항상 식별 정보가 남는다."
        ),
    )


class LlmCompletionResponse(BaseModel):
    """LLM 완성 응답"""
    session_id: str
    content: str
    usage: dict = Field(
        ...,
        description='{"input_tokens": int, "output_tokens": int}',
    )
    model: str
    provider: str
