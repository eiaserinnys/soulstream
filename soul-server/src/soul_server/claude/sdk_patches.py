"""claude-agent-sdk monkey patches.

upstream에 prompt_suggestions 필드가 없어, CLI가 SDK 모드에서 prompt_suggestion을
emit하지 못한다. CLI 디컴파일(v2.1.129)로 확인된 emit 게이트:
    w.promptSuggestions
        && x$.shouldQuery !== false
        && !y4(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)

환경변수는 kill switch이고 SDK init config의 promptSuggestions:true가 활성화 키다.

본 모듈은 Query.initialize를 wrapper로 교체하여 initialize request dict에
promptSuggestions=True를 주입한다. claude/__init__.py가 import하므로 claude
모듈이 로드되는 모든 경로에서 1회 자동 적용.

upstream PR(claude-agent-sdk-python)이 머지·릴리즈되면 본 패치를 제거한다.

추적:
  - 본 작업 카드: https://trello.com/c/1Pt3oIcy
  - 후속 제거 카드: https://trello.com/c/8xnp7jP8
  - upstream repo: https://github.com/anthropics/claude-agent-sdk-python
"""
import logging

from claude_agent_sdk._internal.query import Query

logger = logging.getLogger(__name__)

_original_initialize = Query.initialize


async def _patched_initialize(self):
    """Query.initialize를 감싸 initialize request dict에 promptSuggestions=True 주입."""
    # _send_control_request를 instance-level로 wrapping. 원본은 try/finally로 원복하여
    # initialize 종료 후 다른 control request 흐름(interrupt, mcp_status 등)에 영향 없게 한다.
    original_send = self._send_control_request

    async def _wrapped_send(request, *args, **kwargs):
        if isinstance(request, dict) and request.get("subtype") == "initialize":
            request["promptSuggestions"] = True
            logger.debug(
                "[sdk-patch] injected promptSuggestions=True into initialize request"
            )
        return await original_send(request, *args, **kwargs)

    self._send_control_request = _wrapped_send
    try:
        return await _original_initialize(self)
    finally:
        self._send_control_request = original_send


Query.initialize = _patched_initialize
logger.info(
    "[sdk-patch] Query.initialize patched to inject promptSuggestions=True"
)
