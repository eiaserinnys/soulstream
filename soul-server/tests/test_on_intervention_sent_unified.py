"""T-8: Python `on_intervention_sent` event/intervention_msg dict 단일 통합 회귀 가드.

Phase A context wire 정본 통합 (Y-4, atom d7a1ad86 정본 둘 안티패턴 차단):
이전엔 `event` dict(broadcast — context 누락) vs `intervention_msg` dict(DB persist — context
보존) 두 dict가 분리되어 같은 wire가 wire 경로에 따라 비대칭 payload를 전달했다.
본 사이클이 단일 `event` dict로 통합하여 DB·broadcast·last_message update 모두 공유.

본 테스트는 *task_executor.execute 내부 nested closure*를 직접 호출할 수 없는 한계로
정적 코드 검사 형태로 통합을 보장한다 — 정본 둘 재발(intervention_msg 변수 재도입)을 차단.

대안 검증 (통합 시점):
- 클라이언트 측 라이브 동작 — soul-app/soul-ui에서 running 중 intervention 후
  history replay에서 context block 표시 (사용자 수동 검증)
- soul-server 통합 테스트 (test_task_executor_multiturn.py 유사 패턴) 추가는 본 사이클 범위 외
  (별도 카드).
"""

import inspect

from soul_server.service import task_executor


class TestOnInterventionSentUnified:
    """on_intervention_sent의 event/intervention_msg dict 단일 통합 정적 가드."""

    def test_t8_1_intervention_msg_variable_removed(self):
        """Y-4 통합 회귀 가드: intervention_msg 변수가 더 이상 정의되지 않는다.

        이전 코드: `intervention_msg = {"type": "intervention_sent", "user": user, "text": text, "context": [...]}`
        통합 후: event dict 자체가 context를 carry, intervention_msg dict 분리 제거.
        """
        source = inspect.getsource(task_executor)
        assert "intervention_msg = {" not in source, (
            "Y-4 통합 회귀: intervention_msg dict가 재분리됨 — "
            "atom d7a1ad86 정본 둘 안티패턴 재발. event/intervention_msg 분리 → 단일 event 유지."
        )

    def test_t8_2_event_carries_context_key(self):
        """Y-4 통합: event dict에 context 키를 persist *전* 박는다 (DB persist payload에 포함)."""
        source = inspect.getsource(task_executor)
        assert 'event["context"] = [intervention_soulstream]' in source, (
            "Y-4 통합 회귀: event dict에 context 키 박는 라인이 누락 — "
            "DB persist payload·broadcast payload 모두 context 운반 가능해야 함."
        )

    def test_t8_3_event_id_carried_after_persist(self):
        """Y-4 통합: _event_id 키를 persist *이후* event dict에 박아 broadcast에 carry.

        persist_event의 반환값(int)을 받아 wire 운반. DB 컬럼에는 미저장(ride-along 5자리).
        """
        source = inspect.getsource(task_executor)
        assert 'event["_event_id"] = ev_id' in source, (
            "Y-4 통합 회귀: event dict에 _event_id carry 라인 누락 — "
            "ride-along 5자리(atom b558ca3b·c3fa0fad) 회로 보존 필수."
        )

    def test_t8_4_persist_event_called_with_event_not_intervention_msg(self):
        """Y-4 통합: persist_event 호출 인자가 event(통합 dict)임을 확인.

        이전 코드: `await self._persistence.persist_event(session_id, intervention_msg)`
        통합 후: `await self._persistence.persist_event(session_id, event)`
        """
        source = inspect.getsource(task_executor)
        assert "persist_event(session_id, event)" in source, (
            "Y-4 통합 회귀: persist_event가 event dict가 아닌 다른 dict로 호출됨."
        )
        # 명시적 부재 가드 — intervention_msg 인자 패턴이 다시 나타나지 않도록.
        assert "persist_event(session_id, intervention_msg)" not in source, (
            "Y-4 통합 회귀: persist_event가 intervention_msg dict로 호출 — 통합 깨짐."
        )
