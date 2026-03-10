"""
LLM Adapters - OpenAI/Anthropic 통합 인터페이스

각 LLM 프로바이더를 동일한 인터페이스로 호출하는 어댑터.
"""

import logging
from dataclasses import dataclass
from typing import Protocol

from soul_server.models.llm import LlmMessage

logger = logging.getLogger(__name__)


@dataclass
class LlmResult:
    """LLM 호출 결과"""
    content: str
    input_tokens: int
    output_tokens: int


class LlmAdapter(Protocol):
    """LLM 프로바이더 공통 인터페이스"""

    async def complete(
        self,
        model: str,
        messages: list[LlmMessage],
        max_tokens: int,
        temperature: float | None,
    ) -> LlmResult: ...


class OpenAIAdapter:
    """OpenAI API 어댑터"""

    def __init__(self, api_key: str) -> None:
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(api_key=api_key)

    async def complete(
        self,
        model: str,
        messages: list[LlmMessage],
        max_tokens: int,
        temperature: float | None,
    ) -> LlmResult:
        kwargs: dict = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "max_tokens": max_tokens,
        }
        if temperature is not None:
            kwargs["temperature"] = temperature

        response = await self._client.chat.completions.create(**kwargs)

        if not response.choices:
            raise RuntimeError(
                f"OpenAI returned empty choices for model={model}"
            )
        content = response.choices[0].message.content or ""
        usage = response.usage

        return LlmResult(
            content=content,
            input_tokens=usage.prompt_tokens if usage else 0,
            output_tokens=usage.completion_tokens if usage else 0,
        )


class AnthropicAdapter:
    """Anthropic API 어댑터"""

    def __init__(self, api_key: str) -> None:
        from anthropic import AsyncAnthropic

        self._client = AsyncAnthropic(api_key=api_key)

    async def complete(
        self,
        model: str,
        messages: list[LlmMessage],
        max_tokens: int,
        temperature: float | None,
    ) -> LlmResult:
        # Anthropic은 system 메시지를 별도 파라미터로 전달
        system_parts: list[str] = []
        api_messages: list[dict] = []

        for m in messages:
            if m.role == "system":
                system_parts.append(m.content)
            else:
                api_messages.append({"role": m.role, "content": m.content})

        kwargs: dict = {
            "model": model,
            "messages": api_messages,
            "max_tokens": max_tokens,
        }
        if system_parts:
            kwargs["system"] = "\n\n".join(system_parts)
        if temperature is not None:
            kwargs["temperature"] = temperature

        response = await self._client.messages.create(**kwargs)

        # TextBlock에서 텍스트 추출
        content = ""
        for block in response.content:
            if hasattr(block, "text"):
                content += block.text

        return LlmResult(
            content=content,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
        )
