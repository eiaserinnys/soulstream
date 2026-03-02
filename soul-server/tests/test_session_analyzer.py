"""SessionAnalyzer 테스트

세션 분석기의 단위 테스트.
휴리스틱 기반 카테고리 분류, 제목 생성, 라벨 생성 등을 테스트합니다.
"""

import pytest

from soul_server.service.session_analyzer import (
    SessionAnalyzer,
    SessionEvent,
    SessionSummary,
    WorkCategory,
    CATEGORY_LABELS,
    create_analyzer_from_events,
)


class TestWorkCategory:
    """WorkCategory Enum 테스트"""

    def test_all_categories_have_labels(self):
        """모든 카테고리에 레이블이 정의되어 있어야 함"""
        for category in WorkCategory:
            assert category in CATEGORY_LABELS

    def test_labels_have_emoji(self):
        """모든 레이블에 이모지가 있어야 함"""
        for label in CATEGORY_LABELS.values():
            # 이모지는 보통 2바이트 이상
            assert len(label.encode('utf-8')) > len(label)


class TestSessionEvent:
    """SessionEvent 테스트"""

    def test_basic_event(self):
        """기본 이벤트 생성"""
        event = SessionEvent(
            event_type="user",
            content="안녕하세요",
        )
        assert event.event_type == "user"
        assert event.content == "안녕하세요"
        assert event.tool_name is None
        assert event.tool_input is None

    def test_tool_event(self):
        """도구 이벤트 생성"""
        event = SessionEvent(
            event_type="tool_call",
            content="파일 읽기",
            tool_name="Read",
            tool_input={"file_path": "/path/to/file"},
        )
        assert event.tool_name == "Read"
        assert event.tool_input["file_path"] == "/path/to/file"


class TestSessionAnalyzerBasic:
    """SessionAnalyzer 기본 테스트"""

    def test_empty_analyzer(self):
        """빈 분석기는 MISC 카테고리를 반환해야 함"""
        analyzer = SessionAnalyzer()
        summary = analyzer.analyze()

        assert WorkCategory.MISC in summary.categories
        assert summary.primary_category == WorkCategory.MISC

    def test_add_event(self):
        """이벤트 추가 테스트"""
        analyzer = SessionAnalyzer()

        analyzer.add_event(SessionEvent(
            event_type="user",
            content="테스트 프롬프트",
        ))

        summary = analyzer.analyze()
        assert summary.title  # 제목이 생성되어야 함

    def test_max_events_limit(self):
        """최대 이벤트 수 제한 테스트"""
        analyzer = SessionAnalyzer(max_events=5)

        for i in range(10):
            analyzer.add_event(SessionEvent(
                event_type="response",
                content=f"Response {i}",
            ))

        # 내부 이벤트 수 확인 (최대 5개)
        assert len(analyzer._events) <= 5

    def test_reset(self):
        """상태 초기화 테스트"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(event_type="user", content="test"))

        analyzer.reset()

        assert len(analyzer._events) == 0
        assert len(analyzer._tool_usage) == 0
        assert analyzer._prompt == ""


class TestCategoryClassification:
    """카테고리 분류 테스트"""

    def test_debug_category_from_keywords(self):
        """디버깅 키워드로 DEBUG 카테고리 분류"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="이 버그를 수정해줘. 에러가 발생하고 있어.",
        ))

        summary = analyzer.analyze()
        assert WorkCategory.DEBUG in summary.categories

    def test_docs_category_from_keywords(self):
        """문서 키워드로 DOCS 카테고리 분류"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="README 문서를 업데이트해줘",
        ))

        summary = analyzer.analyze()
        assert WorkCategory.DOCS in summary.categories

    def test_code_category_from_tool(self):
        """Edit 도구 사용으로 CODE 카테고리 분류"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="파일 수정",
            tool_name="Edit",
        ))

        summary = analyzer.analyze()
        assert WorkCategory.CODE in summary.categories

    def test_test_category_from_bash(self):
        """pytest 명령어로 TEST 카테고리 분류"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="테스트 실행",
            tool_name="Bash",
            tool_input={"command": "pytest tests/"},
        ))

        summary = analyzer.analyze()
        assert WorkCategory.TEST in summary.categories

    def test_deploy_category_from_bash(self):
        """docker 명령어로 DEPLOY 카테고리 분류"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="배포",
            tool_name="Bash",
            tool_input={"command": "docker build -t myapp ."},
        ))

        summary = analyzer.analyze()
        assert WorkCategory.DEPLOY in summary.categories

    def test_refactor_category_from_keywords(self):
        """리팩토링 키워드로 REFACTOR 카테고리 분류"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="이 코드를 리팩토링해줘. 정리가 필요해.",
        ))

        summary = analyzer.analyze()
        assert WorkCategory.REFACTOR in summary.categories

    def test_config_category_from_keywords(self):
        """설정 키워드로 CONFIG 카테고리 분류"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content=".env 환경변수 설정을 변경해줘",
        ))

        summary = analyzer.analyze()
        assert WorkCategory.CONFIG in summary.categories

    def test_multiple_categories(self):
        """여러 카테고리 동시 감지"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="버그를 수정하고 테스트를 추가해줘",
        ))
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="수정",
            tool_name="Edit",
        ))

        summary = analyzer.analyze()
        assert WorkCategory.DEBUG in summary.categories
        assert WorkCategory.CODE in summary.categories


class TestPrimaryCategoryDetermination:
    """주요 카테고리 결정 테스트"""

    def test_debug_has_highest_priority(self):
        """DEBUG가 다른 카테고리보다 우선순위가 높아야 함"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="버그 수정하고 문서 업데이트해줘",
        ))

        summary = analyzer.analyze()
        assert summary.primary_category == WorkCategory.DEBUG

    def test_code_over_research(self):
        """CODE가 RESEARCH보다 우선순위가 높아야 함"""
        analyzer = SessionAnalyzer()
        # 디버깅 키워드 없이 순수 도구만 사용
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="새 기능을 추가해줘",  # 버그/수정 키워드 없음
        ))
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="파일 편집",
            tool_name="Edit",
        ))
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="파일 읽기",
            tool_name="Read",
        ))

        summary = analyzer.analyze()
        assert summary.primary_category == WorkCategory.CODE


class TestTitleGeneration:
    """제목 생성 테스트"""

    def test_title_from_simple_prompt(self):
        """간단한 프롬프트에서 제목 생성"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="버그 수정",
        ))

        summary = analyzer.analyze()
        assert summary.title == "버그 수정"

    def test_title_truncation(self):
        """긴 제목은 잘려야 함"""
        analyzer = SessionAnalyzer(title_max_length=20)
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="이것은 매우 긴 프롬프트입니다 이것은 매우 긴 프롬프트입니다",
        ))

        summary = analyzer.analyze()
        assert len(summary.title) <= 20

    def test_title_from_first_sentence(self):
        """첫 문장으로 제목 생성"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="버그를 수정해줘. 로그인 기능에서 에러가 발생해.",
        ))

        summary = analyzer.analyze()
        assert "버그를 수정해줘." in summary.title

    def test_empty_prompt_fallback(self):
        """프롬프트가 없으면 카테고리 기반 제목"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="파일 수정",
            tool_name="Edit",
        ))

        summary = analyzer.analyze()
        assert "코드 작업" in summary.title or "세션" in summary.title


class TestLabelGeneration:
    """라벨 생성 테스트"""

    def test_labels_from_categories(self):
        """카테고리에서 라벨 생성"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="버그 수정",
        ))
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="수정",
            tool_name="Edit",
        ))

        summary = analyzer.analyze()
        assert "🐛 디버깅" in summary.labels
        assert "🔧 코드 작업" in summary.labels

    def test_labels_have_emoji(self):
        """라벨에 이모지가 포함되어야 함"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="테스트",
        ))

        summary = analyzer.analyze()
        for label in summary.labels:
            # 모든 라벨이 이모지를 포함해야 함
            assert any(ord(c) > 127 for c in label)


class TestConfidenceCalculation:
    """신뢰도 계산 테스트"""

    def test_low_confidence_for_empty(self):
        """이벤트가 없으면 신뢰도가 낮아야 함"""
        analyzer = SessionAnalyzer()
        summary = analyzer.analyze()
        # MISC만 있으면 기본 신뢰도 0.3에서 0.1 감소 = 0.2
        assert summary.confidence <= 0.3

    def test_higher_confidence_with_more_events(self):
        """이벤트가 많으면 신뢰도가 높아야 함"""
        analyzer = SessionAnalyzer()
        for i in range(15):
            analyzer.add_event(SessionEvent(
                event_type="tool_call",
                content=f"작업 {i}",
                tool_name="Edit",
            ))

        summary = analyzer.analyze()
        assert summary.confidence > 0.5

    def test_confidence_range(self):
        """신뢰도는 0.0 ~ 1.0 범위여야 함"""
        analyzer = SessionAnalyzer()
        for i in range(100):
            analyzer.add_event(SessionEvent(
                event_type="user",
                content=f"이벤트 {i}",
            ))

        summary = analyzer.analyze()
        assert 0.0 <= summary.confidence <= 1.0


class TestToolUsageTracking:
    """도구 사용 추적 테스트"""

    def test_tool_usage_count(self):
        """도구 사용 횟수 추적"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="수정 1",
            tool_name="Edit",
        ))
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="수정 2",
            tool_name="Edit",
        ))
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="읽기",
            tool_name="Read",
        ))

        summary = analyzer.analyze()
        assert summary.tool_usage["Edit"] == 2
        assert summary.tool_usage["Read"] == 1


class TestCreateAnalyzerFromEvents:
    """create_analyzer_from_events 테스트"""

    def test_from_dict_events(self):
        """딕셔너리 이벤트에서 분석기 생성"""
        events = [
            {"type": "user", "content": "버그 수정해줘"},
            {"type": "tool_start", "tool_name": "Edit", "content": "파일 수정"},
            {"type": "tool_result", "tool_name": "Edit", "content": "완료"},
        ]

        analyzer = create_analyzer_from_events(events)
        summary = analyzer.analyze()

        assert WorkCategory.DEBUG in summary.categories
        assert summary.tool_usage.get("Edit", 0) > 0

    def test_soul_event_types(self):
        """soul:* 이벤트 타입 지원"""
        events = [
            {"type": "soul:user", "content": "테스트"},
            {"type": "soul:tool-call", "tool_name": "Bash", "content": "실행"},
        ]

        analyzer = create_analyzer_from_events(events)
        summary = analyzer.analyze()

        assert "Bash" in summary.tool_usage

    def test_text_field_fallback(self):
        """text 필드 폴백 지원"""
        events = [
            {"type": "user", "text": "프롬프트 내용"},
        ]

        analyzer = create_analyzer_from_events(events)
        assert analyzer._prompt == "프롬프트 내용"


class TestEdgeCases:
    """엣지 케이스 테스트"""

    def test_unicode_in_prompt(self):
        """유니코드 프롬프트 처리"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="user",
            content="한글, 日本語, émojis 🎉 混合 텍스트",
        ))

        summary = analyzer.analyze()
        assert summary.title  # 제목이 생성되어야 함

    def test_very_long_prompt(self):
        """매우 긴 프롬프트 처리"""
        analyzer = SessionAnalyzer(title_max_length=50)
        long_prompt = "a" * 1000

        analyzer.add_event(SessionEvent(
            event_type="user",
            content=long_prompt,
        ))

        summary = analyzer.analyze()
        assert len(summary.title) <= 50

    def test_empty_tool_input(self):
        """빈 tool_input 처리"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="실행",
            tool_name="Bash",
            tool_input={},  # 빈 딕셔너리
        ))

        # 예외 없이 분석 완료
        summary = analyzer.analyze()
        assert WorkCategory.CODE in summary.categories

    def test_none_tool_input(self):
        """None tool_input 처리"""
        analyzer = SessionAnalyzer()
        analyzer.add_event(SessionEvent(
            event_type="tool_call",
            content="실행",
            tool_name="Bash",
            tool_input=None,
        ))

        # 예외 없이 분석 완료
        summary = analyzer.analyze()
        assert summary is not None
