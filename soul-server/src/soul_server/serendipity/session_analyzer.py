"""Session Analyzer

세션 종료 시 대화 내용을 분석하여 메타데이터를 자동 생성합니다.

기능:
- LLM 기반 세션 제목 자동 생성
- 작업 태그 자동 분류 (코드, 문서, 디버깅, 설정 등)
- 세렌디피티 라벨 자동 부착

Note:
  이 기능은 세렌디피티 모드에서만 사용됩니다.
  파일 모드에서는 기존 방식대로 파일 시스템에 저장됩니다.
"""

import logging
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


# ============================================================================
# Constants
# ============================================================================

class WorkCategory(str, Enum):
    """작업 카테고리 (자동 분류용)"""
    CODE = "code"           # 코드 작성/수정
    DEBUG = "debug"         # 디버깅/문제 해결
    DOCS = "docs"           # 문서 작성/수정
    CONFIG = "config"       # 설정 변경
    REFACTOR = "refactor"   # 리팩토링
    TEST = "test"           # 테스트 작성/실행
    DEPLOY = "deploy"       # 배포 관련
    RESEARCH = "research"   # 조사/탐색
    REVIEW = "review"       # 코드 리뷰
    MISC = "misc"           # 기타


# 카테고리별 레이블 이모지 매핑
CATEGORY_LABELS: Dict[WorkCategory, str] = {
    WorkCategory.CODE: "🔧 코드 작업",
    WorkCategory.DEBUG: "🐛 디버깅",
    WorkCategory.DOCS: "📝 문서 작업",
    WorkCategory.CONFIG: "⚙️ 설정",
    WorkCategory.REFACTOR: "♻️ 리팩토링",
    WorkCategory.TEST: "🧪 테스트",
    WorkCategory.DEPLOY: "🚀 배포",
    WorkCategory.RESEARCH: "🔍 조사",
    WorkCategory.REVIEW: "👀 코드 리뷰",
    WorkCategory.MISC: "📦 기타",
}

# 도구 → 카테고리 매핑 (휴리스틱)
TOOL_CATEGORY_MAP: Dict[str, WorkCategory] = {
    # 코드 작성 도구
    "Edit": WorkCategory.CODE,
    "Write": WorkCategory.CODE,
    "NotebookEdit": WorkCategory.CODE,

    # 읽기/조사 도구
    "Read": WorkCategory.RESEARCH,
    "Glob": WorkCategory.RESEARCH,
    "Grep": WorkCategory.RESEARCH,
    "WebFetch": WorkCategory.RESEARCH,
    "WebSearch": WorkCategory.RESEARCH,

    # 실행/테스트 도구
    "Bash": WorkCategory.CODE,  # 기본값, 컨텍스트에 따라 변경

    # 기타
    "Task": WorkCategory.MISC,
}

# 키워드 → 카테고리 매핑 (프롬프트/응답 분석용)
# Note: 한글은 \b가 제대로 작동하지 않으므로 영어에만 \b 적용
KEYWORD_PATTERNS: Dict[WorkCategory, List[str]] = {
    WorkCategory.DEBUG: [
        r"(?:디버그|버그|수정|오류|에러)",  # 한글
        r"\b(debug|bug|fix|error|exception|traceback)\b",  # 영어
        r"(?:문제|실패)",  # 한글
        r"\b(issue|problem|crash|fail)\b",  # 영어
    ],
    WorkCategory.DOCS: [
        r"(?:문서|주석|설명)",  # 한글
        r"\b(readme|document|docs|comment|description)\b",  # 영어
        r"\b(markdown|md|wiki)\b",
    ],
    WorkCategory.CONFIG: [
        r"(?:설정|환경변수)",  # 한글
        r"\b(config|configuration|env|yaml|json|toml)\b",  # 영어
        r"(?:\.env|settings|preference)",
    ],
    WorkCategory.REFACTOR: [
        r"(?:리팩토링|리팩터|정리)",  # 한글
        r"\b(refactor|cleanup|reorganize)\b",  # 영어
        r"(?:개선|최적화)",  # 한글
        r"\b(improve|optimize)\b",  # 영어
    ],
    WorkCategory.TEST: [
        r"(?:테스트|커버리지)",  # 한글
        r"\b(test|pytest|vitest|jest|unittest)\b",  # 영어
        r"\b(coverage|assertion|mock)\b",
    ],
    WorkCategory.DEPLOY: [
        r"(?:배포|릴리스)",  # 한글
        r"\b(deploy|release|publish|docker|kubernetes|k8s)\b",  # 영어
        r"\b(ci|cd|github actions|workflow)\b",
    ],
    WorkCategory.REVIEW: [
        r"(?:리뷰|머지)",  # 한글
        r"\b(review|pr|pull request|merge)\b",  # 영어
        r"\b(approve|comment|suggestion)\b",
    ],
}

# Bash 명령어 → 카테고리 매핑
BASH_COMMAND_PATTERNS: Dict[WorkCategory, List[str]] = {
    WorkCategory.TEST: [
        r"\b(pytest|vitest|jest|npm test|yarn test|pnpm test)\b",
        r"\b(coverage|test:)\b",
    ],
    WorkCategory.DEPLOY: [
        r"\b(docker|kubectl|helm|terraform)\b",
        r"\b(npm publish|yarn publish|pip install)\b",
        r"\b(git push|git tag)\b",
    ],
    WorkCategory.DEBUG: [
        r"\b(tail|journalctl|systemctl status)\b",
        r"\b(ps aux|htop|top)\b",
    ],
}


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class SessionSummary:
    """세션 분석 결과"""
    title: str                              # 자동 생성된 제목
    categories: Set[WorkCategory]           # 감지된 작업 카테고리
    labels: List[str]                       # 부착할 세렌디피티 라벨
    primary_category: WorkCategory          # 주요 카테고리
    tool_usage: Dict[str, int]              # 도구 사용 횟수
    confidence: float                       # 분류 신뢰도 (0.0 ~ 1.0)


@dataclass
class SessionEvent:
    """분석용 세션 이벤트 (간소화된 형태)"""
    event_type: str                         # "user", "response", "tool_call", "tool_result"
    content: str                            # 텍스트 내용
    tool_name: Optional[str] = None         # 도구 이름 (tool_* 이벤트)
    tool_input: Optional[Dict[str, Any]] = None  # 도구 입력


# ============================================================================
# Session Analyzer
# ============================================================================

class SessionAnalyzer:
    """세션 대화 내용을 분석하여 메타데이터를 자동 생성

    휴리스틱 기반 분석:
    - 사용된 도구 분석
    - 프롬프트/응답 키워드 매칭
    - Bash 명령어 패턴 분석

    LLM 기반 분석 (선택적):
    - 복잡한 대화의 제목 생성
    - 세밀한 카테고리 분류

    Usage:
        analyzer = SessionAnalyzer()

        # 이벤트 수집
        analyzer.add_event(SessionEvent("user", "버그를 수정해줘"))
        analyzer.add_event(SessionEvent("tool_call", "파일 수정", tool_name="Edit"))

        # 분석
        summary = analyzer.analyze()
        print(summary.title)  # "버그 수정 작업"
        print(summary.labels)  # ["🐛 디버깅", "🔧 코드 작업"]
    """

    def __init__(
        self,
        max_events: int = 100,
        title_max_length: int = 50,
    ):
        """
        Args:
            max_events: 분석할 최대 이벤트 수 (메모리 제한)
            title_max_length: 생성 제목 최대 길이
        """
        self._max_events = max_events
        self._title_max_length = title_max_length
        self._events: List[SessionEvent] = []
        self._tool_usage: Dict[str, int] = {}
        self._prompt: str = ""  # 최초 사용자 프롬프트

    def add_event(self, event: SessionEvent) -> None:
        """이벤트 추가

        Args:
            event: 분석할 세션 이벤트
        """
        if len(self._events) >= self._max_events:
            # FIFO: 오래된 이벤트 제거 (최초 프롬프트는 유지)
            if len(self._events) > 1:
                self._events.pop(1)

        self._events.append(event)

        # 최초 프롬프트 저장
        if not self._prompt and event.event_type == "user":
            self._prompt = event.content

        # 도구 사용 횟수 집계
        if event.tool_name:
            self._tool_usage[event.tool_name] = self._tool_usage.get(event.tool_name, 0) + 1

    def analyze(self) -> SessionSummary:
        """세션 분석 실행

        Returns:
            SessionSummary: 분석 결과
        """
        # 1. 카테고리 분류
        categories = self._classify_categories()

        # 2. 주요 카테고리 결정
        primary = self._determine_primary_category(categories)

        # 3. 제목 생성
        title = self._generate_title(primary)

        # 4. 라벨 목록 생성
        labels = self._generate_labels(categories)

        # 5. 신뢰도 계산
        confidence = self._calculate_confidence(categories)

        return SessionSummary(
            title=title,
            categories=categories,
            labels=labels,
            primary_category=primary,
            tool_usage=self._tool_usage.copy(),
            confidence=confidence,
        )

    def _classify_categories(self) -> Set[WorkCategory]:
        """카테고리 분류 (휴리스틱)

        Returns:
            감지된 카테고리 집합
        """
        categories: Set[WorkCategory] = set()

        # 1. 도구 기반 분류
        for tool_name, count in self._tool_usage.items():
            if tool_name in TOOL_CATEGORY_MAP:
                categories.add(TOOL_CATEGORY_MAP[tool_name])

        # 2. 키워드 기반 분류
        all_text = self._collect_text()
        for category, patterns in KEYWORD_PATTERNS.items():
            for pattern in patterns:
                if re.search(pattern, all_text, re.IGNORECASE):
                    categories.add(category)
                    break

        # 3. Bash 명령어 분석
        bash_commands = self._collect_bash_commands()
        for category, patterns in BASH_COMMAND_PATTERNS.items():
            for pattern in patterns:
                if any(re.search(pattern, cmd, re.IGNORECASE) for cmd in bash_commands):
                    categories.add(category)
                    break

        # 기본값
        if not categories:
            categories.add(WorkCategory.MISC)

        return categories

    def _determine_primary_category(self, categories: Set[WorkCategory]) -> WorkCategory:
        """주요 카테고리 결정

        우선순위: DEBUG > CODE > TEST > REFACTOR > DOCS > CONFIG > DEPLOY > RESEARCH > REVIEW > MISC

        Args:
            categories: 감지된 카테고리 집합

        Returns:
            주요 카테고리
        """
        priority = [
            WorkCategory.DEBUG,
            WorkCategory.CODE,
            WorkCategory.TEST,
            WorkCategory.REFACTOR,
            WorkCategory.DOCS,
            WorkCategory.CONFIG,
            WorkCategory.DEPLOY,
            WorkCategory.RESEARCH,
            WorkCategory.REVIEW,
            WorkCategory.MISC,
        ]

        for cat in priority:
            if cat in categories:
                return cat

        return WorkCategory.MISC

    def _generate_title(self, primary: WorkCategory) -> str:
        """제목 생성 (휴리스틱)

        최초 프롬프트에서 핵심 내용을 추출하여 제목 생성.

        Args:
            primary: 주요 카테고리

        Returns:
            생성된 제목 (최대 50자)
        """
        if not self._prompt:
            return f"{CATEGORY_LABELS[primary]} 세션"

        # 프롬프트에서 제목 추출
        title = self._extract_title_from_prompt(self._prompt)

        # 길이 제한
        if len(title) > self._title_max_length:
            title = title[:self._title_max_length - 3] + "..."

        return title

    def _extract_title_from_prompt(self, prompt: str) -> str:
        """프롬프트에서 제목 추출

        Args:
            prompt: 사용자 프롬프트

        Returns:
            추출된 제목
        """
        # 줄바꿈 제거, 공백 정규화
        text = re.sub(r'\s+', ' ', prompt).strip()

        # 첫 문장 또는 첫 줄 추출
        # 마침표, 물음표, 느낌표로 끝나는 첫 문장
        match = re.match(r'^(.+?[.?!])\s', text)
        if match:
            return match.group(1)

        # 첫 50자
        if len(text) <= self._title_max_length:
            return text

        # 단어 경계에서 자르기
        words = text[:self._title_max_length + 10].split()
        result = ""
        for word in words:
            if len(result) + len(word) + 1 > self._title_max_length:
                break
            result += (" " if result else "") + word

        return result or text[:self._title_max_length]

    def _generate_labels(self, categories: Set[WorkCategory]) -> List[str]:
        """라벨 목록 생성

        Args:
            categories: 감지된 카테고리 집합

        Returns:
            부착할 라벨 목록
        """
        labels = []

        for category in categories:
            if category in CATEGORY_LABELS:
                labels.append(CATEGORY_LABELS[category])

        return labels

    def _calculate_confidence(self, categories: Set[WorkCategory]) -> float:
        """분류 신뢰도 계산

        신뢰도 요소:
        - 이벤트 수: 많을수록 신뢰도 상승
        - 도구 사용: 명확한 도구 사용 시 신뢰도 상승
        - 카테고리 수: 적을수록 신뢰도 상승 (명확한 분류)
        - MISC 카테고리만 있으면 신뢰도 감소

        Args:
            categories: 감지된 카테고리 집합

        Returns:
            신뢰도 (0.0 ~ 1.0)
        """
        confidence = 0.3  # 기본값 (낮게 시작)

        # 이벤트 수 반영
        event_count = len(self._events)
        if event_count >= 10:
            confidence += 0.25
        elif event_count >= 5:
            confidence += 0.15
        elif event_count >= 1:
            confidence += 0.1

        # 도구 사용 반영
        if self._tool_usage:
            total_tool_calls = sum(self._tool_usage.values())
            if total_tool_calls >= 5:
                confidence += 0.25
            elif total_tool_calls >= 2:
                confidence += 0.15
            elif total_tool_calls >= 1:
                confidence += 0.1

        # 카테고리 수 반영
        category_count = len(categories)
        non_misc = [c for c in categories if c != WorkCategory.MISC]

        if len(non_misc) >= 1:
            # MISC 외의 카테고리가 있으면 신뢰도 상승
            confidence += 0.1
            if len(non_misc) == 1:
                confidence += 0.1  # 명확한 단일 카테고리
        elif category_count == 1 and WorkCategory.MISC in categories:
            # MISC만 있으면 신뢰도 감소
            confidence -= 0.1

        if category_count > 3:
            confidence -= 0.1  # 너무 많은 카테고리

        # 범위 제한
        return max(0.0, min(1.0, confidence))

    def _collect_text(self) -> str:
        """모든 이벤트의 텍스트 수집

        Returns:
            연결된 텍스트
        """
        texts = []
        for event in self._events:
            texts.append(event.content)
        return " ".join(texts)

    def _collect_bash_commands(self) -> List[str]:
        """Bash 도구 호출에서 명령어 수집

        Returns:
            명령어 목록
        """
        commands = []
        for event in self._events:
            if event.tool_name == "Bash" and event.tool_input:
                cmd = event.tool_input.get("command", "")
                if cmd:
                    commands.append(cmd)
        return commands

    def reset(self) -> None:
        """상태 초기화"""
        self._events.clear()
        self._tool_usage.clear()
        self._prompt = ""


# ============================================================================
# Helper Functions
# ============================================================================

def create_analyzer_from_events(events: List[Dict[str, Any]]) -> SessionAnalyzer:
    """이벤트 딕셔너리 목록에서 분석기 생성

    Args:
        events: SSE 이벤트 딕셔너리 목록

    Returns:
        초기화된 SessionAnalyzer
    """
    analyzer = SessionAnalyzer()

    for event in events:
        event_type = event.get("type", "")
        content = event.get("content", "") or event.get("text", "")
        tool_name = event.get("tool_name")
        tool_input = event.get("tool_input")

        # 이벤트 타입 매핑
        if event_type in ("user", "soul:user"):
            mapped_type = "user"
        elif event_type in ("response", "soul:response", "text_delta"):
            mapped_type = "response"
        elif event_type in ("tool_call", "soul:tool-call", "tool_start"):
            mapped_type = "tool_call"
        elif event_type in ("tool_result", "soul:tool-result"):
            mapped_type = "tool_result"
        else:
            continue

        analyzer.add_event(SessionEvent(
            event_type=mapped_type,
            content=content,
            tool_name=tool_name,
            tool_input=tool_input,
        ))

    return analyzer
