"""claude-agent-sdk monkey patches.

CLI 디컴파일(v2.1.129)과 실 사용 진단으로 확인된 두 가지 SDK 한계를 우회한다.

  §1. **emit 게이트 활성화** — Query.initialize의 control request에
      promptSuggestions=True 주입 (CLI emit 가드 통과)
  §2. **top-level type 인식** — message_parser.parse_message wrapping으로
      `{"type": "prompt_suggestion", ...}` 메시지를 PromptSuggestionMessage로 변환
      (SDK default case의 silent drop 회피)

두 patch는 대칭적으로 함께 동작해야 prompt_suggestion이 EngineEvent까지 흐른다.

## 1. emit 게이트 활성화 (Query.initialize)

CLI emit 게이트:
    w.promptSuggestions
        && x$.shouldQuery !== false
        && !y4(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)

환경변수는 kill switch이고 SDK init config의 promptSuggestions:true가 활성화 키다.
Python SDK 0.1.74의 ClaudeAgentOptions에 해당 필드가 없어 Query.initialize의
request dict에 monkey-patch로 주입한다.

## 2. parse_message silent drop 회피

CLI는 prompt_suggestion을 user/assistant/system/result처럼 top-level 메시지로
emit한다:
    {"type": "prompt_suggestion", "suggestion": "...", "uuid": "...", "session_id": "..."}

claude-agent-sdk 0.1.74 _internal/message_parser.py L284 default case:
    case _:
        logger.debug("Skipping unknown message type: %s", message_type)
        return None

→ unknown type을 silent drop. 본 모듈은 parse_message를 wrapping하여
type=='prompt_suggestion'을 PromptSuggestionMessage 전용 클래스로 변환한다.
주의: SDK 내부에서 `from .message_parser import parse_message`로 함수를 직접
import한 호출자(_internal/client.py L15)가 있으므로 module attribute 갱신과
별개로 client 모듈의 attribute도 함께 set한다.

## 적용 시점·범위

claude/__init__.py가 import하므로 soul_server.claude 모듈이 로드되는 모든
경로에서 1회 자동 적용. Python module cache로 재실행 안 됨.

## 추적 / 제거 조건

upstream PR(claude-agent-sdk-python)이 머지·릴리즈되면 본 패치를 제거한다.
upstream PR은 결국 ClaudeAgentOptions.prompt_suggestions: bool 필드 +
PromptSuggestionMessage 정식 타입 추가 형태일 것이라, 본 우회는 그 형태에
미리 수렴해두어 머지 후 제거가 깔끔한 import 교체로 끝난다.

  - 본 작업 카드 (parser fix): https://trello.com/c/Mr4AmEjL
  - 선행 카드 (initialize 패치): https://trello.com/c/1Pt3oIcy
  - 후속 제거 카드: https://trello.com/c/8xnp7jP8
  - upstream repo: https://github.com/anthropics/claude-agent-sdk-python
"""
import logging
from dataclasses import dataclass
from typing import Any, Optional

import claude_agent_sdk._internal.client as _sdk_client
import claude_agent_sdk._internal.message_parser as _msg_parser
from claude_agent_sdk._internal.query import Query

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# 1) Query.initialize wrapper — emit gate 활성화
# ─────────────────────────────────────────────────────────────────────────────

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


# ─────────────────────────────────────────────────────────────────────────────
# 2) parse_message wrapper — top-level prompt_suggestion 인식
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class PromptSuggestionMessage:
    """CLI가 turn 직후 emit하는 prompt_suggestion top-level 메시지.

    SDK 0.1.74까지 SDK 본체에 정의되지 않아 message_parser가 silent drop한다.
    upstream PR이 머지되면 SDK의 정식 타입(예: claude_agent_sdk.types.PromptSuggestionMessage)
    으로 교체되며, 본 클래스는 제거 대상이다.

    uuid·session_id는 현재 _handle_prompt_suggestion에서 사용하지 않지만, upstream
    정식 타입과 시그니처를 맞춰두어 머지 후 import 교체 시 호환성을 유지한다. 또한
    디버그 시 어떤 turn의 suggestion인지 추적하는 데 활용 가능.
    """

    suggestion: str
    uuid: Optional[str] = None
    session_id: Optional[str] = None


_original_parse_message = _msg_parser.parse_message


def _patched_parse_message(data: Any):
    """type=='prompt_suggestion'을 PromptSuggestionMessage로 변환. 그 외는 원본 위임."""
    if isinstance(data, dict) and data.get("type") == "prompt_suggestion":
        return PromptSuggestionMessage(
            suggestion=data.get("suggestion", "") or "",
            uuid=data.get("uuid"),
            session_id=data.get("session_id"),
        )
    return _original_parse_message(data)


# 모듈 attribute 갱신 — 모듈 경로로 lookup하는 호출자(claude_agent_sdk/client.py L276 같은
# 함수 내부 import)에 적용된다.
_msg_parser.parse_message = _patched_parse_message

# 이미 import된 참조 갱신 — _internal/client.py L15 `from .message_parser import parse_message`
# 형태로 캡처된 모듈 변수는 위 module attribute 갱신만으로는 바뀌지 않는다.
_sdk_client.parse_message = _patched_parse_message

logger.info(
    "[sdk-patch] message_parser.parse_message patched (module + client) to recognize "
    "prompt_suggestion top-level type as PromptSuggestionMessage"
)
