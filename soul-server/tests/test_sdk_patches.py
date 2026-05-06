"""sdk_patches monkey-patch 테스트.

Query.initialize wrapper가 initialize request에 promptSuggestions=True를
주입하는지, 그리고 다른 subtype에는 주입하지 않는지를 검증한다.

실제 Query 인스턴스화는 transport 의존성 때문에 부담이라 _send_control_request만
모방하는 더미 객체를 만들어 self로 사용한다. Query.initialize는 이미 module
import 시점에 patched 상태이므로 그대로 호출 가능.
"""
import pytest

# import 부수효과로 monkey-patch 적용 (claude/__init__.py가 sdk_patches를 import).
import soul_server.claude  # noqa: F401
from claude_agent_sdk._internal.query import Query


class _DummyQuery:
    """Query.initialize가 실제로 사용하는 attribute만 흉내내는 더미.

    Query.initialize는 다음을 사용:
      - self.is_streaming_mode (True여야 control request 진입)
      - self.hooks (None이면 hooks_config 빈 dict)
      - self._agents / self._exclude_dynamic_sections / self._skills (옵션)
      - self._initialize_timeout (timeout 인자)
      - self.next_callback_id / self.hook_callbacks (hooks 처리용)
      - self._send_control_request (control 메시지 송출 — 본 테스트의 spy)
      - self._initialized / self._initialization_result (결과 저장)
    """

    def __init__(self):
        self.is_streaming_mode = True
        self.hooks = None
        self._agents = None
        self._exclude_dynamic_sections = None
        self._skills = None
        self._initialize_timeout = 30
        self.next_callback_id = 0
        self.hook_callbacks = {}
        self._initialized = False
        self._initialization_result = None
        self.captured: list[dict] = []

        async def _send(request, *args, **kwargs):
            # control_request에 전달된 dict를 캡처. 더미라 실제 전송하지 않고 빈 응답 반환.
            self.captured.append(dict(request))
            return {}

        self._send_control_request = _send


@pytest.mark.asyncio
async def test_initialize_injects_prompt_suggestions_true():
    """initialize subtype request에 promptSuggestions=True가 주입되어야 한다."""
    q = _DummyQuery()
    await Query.initialize(q)

    init_requests = [r for r in q.captured if r.get("subtype") == "initialize"]
    assert len(init_requests) == 1, f"expected 1 initialize request, got {len(init_requests)}"
    assert init_requests[0].get("promptSuggestions") is True


@pytest.mark.asyncio
async def test_send_control_request_restored_after_initialize():
    """initialize 종료 후 _send_control_request가 원본으로 복원되어야 한다."""
    q = _DummyQuery()
    original_send = q._send_control_request
    await Query.initialize(q)
    # finally에서 원복했으므로 동일 함수 객체여야 한다.
    assert q._send_control_request is original_send


@pytest.mark.asyncio
async def test_non_initialize_subtype_not_injected_in_outer_calls():
    """initialize wrapping이 종료된 뒤에는 다른 subtype에 주입되지 않는다.

    initialize 내부에서만 wrapping이 활성화되고, 이후 호출(예: interrupt, mcp_status)은
    원본 _send_control_request로 흐르므로 promptSuggestions 키가 추가되지 않아야 한다.
    """
    q = _DummyQuery()
    await Query.initialize(q)

    # initialize 종료 후 다른 subtype 송출 시뮬
    await q._send_control_request({"subtype": "interrupt"})
    interrupt_requests = [r for r in q.captured if r.get("subtype") == "interrupt"]
    assert len(interrupt_requests) == 1
    assert "promptSuggestions" not in interrupt_requests[0]


@pytest.mark.asyncio
async def test_initialize_request_otherwise_intact():
    """initialize 본래 필드(subtype, hooks 등)는 그대로 유지되어야 한다."""
    q = _DummyQuery()
    await Query.initialize(q)

    init = next(r for r in q.captured if r.get("subtype") == "initialize")
    # 원본 빌더가 만드는 표준 키들이 보존되어야 한다.
    assert "subtype" in init
    assert init["subtype"] == "initialize"
    # hooks는 hooks가 None이라 None으로 들어감
    assert init.get("hooks") is None
    # 우리 주입 필드가 들어와 있다
    assert init["promptSuggestions"] is True


@pytest.mark.asyncio
async def test_send_control_request_restored_after_initialize_exception():
    """initialize 도중 _send_control_request가 예외를 던져도 finally가 원본을 원복한다.

    회귀 방지 — wrapping 누수가 다른 control request 흐름(interrupt, mcp_status 등)에
    영향을 주는 사고를 막는다.
    """
    q = _DummyQuery()

    async def _raising(request, *args, **kwargs):
        raise RuntimeError("simulated failure inside _send_control_request")

    q._send_control_request = _raising
    raising_send = q._send_control_request

    with pytest.raises(RuntimeError, match="simulated failure"):
        await Query.initialize(q)

    # finally가 원래 함수(_raising)를 원복했어야 한다.
    assert q._send_control_request is raising_send


@pytest.mark.asyncio
async def test_double_initialize_does_not_accumulate_wrapping():
    """같은 인스턴스에 initialize를 두 번 호출해도 wrapping이 누적되지 않는다.

    매 호출마다 original_send가 *현재* attribute를 캡처하므로 finally가 원복한 뒤에는
    다음 호출이 원본을 다시 캡처한다. 두 번째 initialize도 promptSuggestions=True를
    정확히 1회만 주입한다 (재귀 wrapping 누적 없음).
    """
    q = _DummyQuery()
    await Query.initialize(q)
    await Query.initialize(q)

    inits = [r for r in q.captured if r.get("subtype") == "initialize"]
    assert len(inits) == 2
    assert all(r.get("promptSuggestions") is True for r in inits)
    # 키가 단일하게 들어가 있는지 (중복 wrapping이면 같은 키가 여러 번 set되어도 결과 동일하나
    # request dict에는 단일 키만 존재)
    assert all(list(r.keys()).count("promptSuggestions") == 1 for r in inits)
