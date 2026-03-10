"""
LLM Proxy - Pydantic 스키마

LLM 프록시 API의 요청/응답 모델을 정의합니다.
"""

from typing import Literal, Optional

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
