"""
test_session_broadcaster - SessionBroadcaster 테스트

TDD 방식으로 작성:
1. get_session_broadcaster: 초기화 안 된 상태에서 RuntimeError 발생
2. init_session_broadcaster: 초기화 후 정상 반환
3. set_session_broadcaster: 테스트용 인스턴스 설정
"""

import pytest
from soul_server.service.session_broadcaster import (
    SessionBroadcaster,
    get_session_broadcaster,
    init_session_broadcaster,
    set_session_broadcaster,
)


@pytest.fixture(autouse=True)
def reset_broadcaster():
    """각 테스트 전후로 broadcaster 상태 초기화"""
    set_session_broadcaster(None)
    yield
    set_session_broadcaster(None)


class TestGetSessionBroadcaster:
    """get_session_broadcaster 테스트"""

    def test_raises_runtime_error_when_not_initialized(self):
        """초기화되지 않은 상태에서 RuntimeError 발생"""
        with pytest.raises(RuntimeError) as exc_info:
            get_session_broadcaster()
        assert "not initialized" in str(exc_info.value)

    def test_returns_broadcaster_after_init(self):
        """초기화 후 정상적으로 SessionBroadcaster 반환"""
        init_session_broadcaster()
        broadcaster = get_session_broadcaster()
        assert isinstance(broadcaster, SessionBroadcaster)

    def test_returns_same_instance(self):
        """동일한 인스턴스를 반환한다"""
        init_session_broadcaster()
        b1 = get_session_broadcaster()
        b2 = get_session_broadcaster()
        assert b1 is b2


class TestInitSessionBroadcaster:
    """init_session_broadcaster 테스트"""

    def test_creates_new_instance(self):
        """새 SessionBroadcaster 인스턴스 생성"""
        broadcaster = init_session_broadcaster()
        assert isinstance(broadcaster, SessionBroadcaster)

    def test_replaces_existing_instance(self):
        """기존 인스턴스를 교체한다"""
        b1 = init_session_broadcaster()
        b2 = init_session_broadcaster()
        assert b1 is not b2
        assert get_session_broadcaster() is b2


class TestSetSessionBroadcaster:
    """set_session_broadcaster 테스트 (테스트용)"""

    def test_set_custom_instance(self):
        """커스텀 인스턴스 설정"""
        custom = SessionBroadcaster()
        set_session_broadcaster(custom)
        assert get_session_broadcaster() is custom

    def test_set_none_clears_instance(self):
        """None 설정 시 인스턴스 제거"""
        init_session_broadcaster()
        set_session_broadcaster(None)
        with pytest.raises(RuntimeError):
            get_session_broadcaster()
