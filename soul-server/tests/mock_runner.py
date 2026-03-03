"""
EventDrivenMockRunner - 실제 세션 데이터로 Claude Code 동작 시뮬레이션

Claude Code 중첩 실행 문제 해결:
통합 테스트에서 실제 Claude Code를 실행하면 중첩 에러가 발생합니다.
이 모듈은 실제 세션 데이터(fixtures/*.jsonl)로 Claude Code 동작을 시뮬레이션합니다.

타이밍 동기화:
- ready: Runner 준비 완료 (run() 호출 후 첫 yield 전)
- proceed: 다음 이벤트 진행 허용
- event_emitted: 이벤트 발행 완료

사용 예:
    runner = EventDrivenMockRunner(fixture_path)

    # 모든 이벤트 즉시 발행
    runner.emit_all_immediately = True
    async for event in runner.run("test prompt"):
        process(event)

    # 하나씩 제어하며 발행
    runner.emit_all_immediately = False
    task = asyncio.create_task(runner.run("test prompt"))
    await runner.ready.wait()

    await runner.emit_next()  # 첫 이벤트
    await runner.emit_until("complete")  # complete까지
"""

import asyncio
import json
from pathlib import Path
from typing import AsyncIterator, List, Optional


class EventDrivenMockRunner:
    """실제 세션 데이터로 Claude Code 동작 시뮬레이션

    Attributes:
        events: 로드된 이벤트 목록
        ready: Runner 준비 완료 이벤트
        proceed: 다음 이벤트 진행 허용 이벤트
        event_emitted: 이벤트 발행 완료 이벤트
        last_event: 마지막으로 발행된 이벤트
        current_index: 현재 이벤트 인덱스
        emit_all_immediately: True면 모든 이벤트를 즉시 발행
    """

    def __init__(self, fixture_path: Path):
        """
        Args:
            fixture_path: 세션 데이터 JSONL 파일 경로
        """
        self.fixture_path = fixture_path
        self.events = self._load_events(fixture_path)

        # 동기화 이벤트
        self.ready = asyncio.Event()
        self.proceed = asyncio.Event()
        self.event_emitted = asyncio.Event()

        # 상태
        self.last_event: Optional[dict] = None
        self.current_index = 0

        # 모드
        self.emit_all_immediately = False

    def _load_events(self, path: Path) -> List[dict]:
        """JSONL 파일에서 이벤트 로드

        각 줄은 {"id": n, "event": {...}} 형식입니다.
        """
        events = []
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                data = json.loads(line)
                events.append(data["event"])
        return events

    def reset(self) -> None:
        """상태 초기화"""
        self.ready.clear()
        self.proceed.clear()
        self.event_emitted.clear()
        self.last_event = None
        self.current_index = 0

    async def run(self, prompt: str) -> AsyncIterator[dict]:
        """Claude Code 실행 시뮬레이션

        Args:
            prompt: 실행 프롬프트 (무시됨, 픽스처 데이터 사용)

        Yields:
            이벤트 dict
        """
        self.reset()
        self.ready.set()

        for event in self.events:
            if not self.emit_all_immediately:
                # 외부에서 proceed.set() 호출을 대기
                await self.proceed.wait()
                self.proceed.clear()

            self.last_event = event
            self.current_index += 1
            yield event

            if not self.emit_all_immediately:
                # 이벤트 발행 완료 알림
                self.event_emitted.set()

    def emit_all(self) -> None:
        """모든 이벤트를 즉시 발행 모드로 전환

        이미 대기 중인 경우 proceed를 설정합니다.
        """
        self.emit_all_immediately = True
        self.proceed.set()

    async def emit_next(self) -> Optional[dict]:
        """다음 이벤트 하나만 발행

        Returns:
            발행된 이벤트 또는 None (더 이상 이벤트 없음)
        """
        if self.current_index >= len(self.events):
            return None

        self.event_emitted.clear()
        self.proceed.set()

        # 이벤트 발행 완료 대기
        await asyncio.wait_for(self.event_emitted.wait(), timeout=5.0)

        return self.last_event

    async def emit_until(self, event_type: str) -> List[dict]:
        """특정 타입의 이벤트까지 발행

        Args:
            event_type: 대상 이벤트 타입 (예: "complete", "error")

        Returns:
            발행된 이벤트 목록
        """
        emitted = []

        while self.current_index < len(self.events):
            event = await self.emit_next()
            if event is None:
                break

            emitted.append(event)

            if event.get("type") == event_type:
                break

        return emitted

    async def emit_count(self, count: int) -> List[dict]:
        """지정된 수만큼 이벤트 발행

        Args:
            count: 발행할 이벤트 수

        Returns:
            발행된 이벤트 목록
        """
        emitted = []

        for _ in range(count):
            if self.current_index >= len(self.events):
                break

            event = await self.emit_next()
            if event:
                emitted.append(event)

        return emitted

    @property
    def remaining_count(self) -> int:
        """남은 이벤트 수"""
        return len(self.events) - self.current_index

    @property
    def is_complete(self) -> bool:
        """모든 이벤트가 발행되었는지"""
        return self.current_index >= len(self.events)

    @property
    def has_error_event(self) -> bool:
        """에러 이벤트가 있는지"""
        return any(e.get("type") == "error" for e in self.events)

    @property
    def has_complete_event(self) -> bool:
        """complete 이벤트가 있는지"""
        return any(e.get("type") == "complete" for e in self.events)


# 편의 함수
def load_fixture(name: str) -> Path:
    """픽스처 파일 경로 반환

    Args:
        name: 파일 이름 (확장자 제외)

    Returns:
        픽스처 파일 경로
    """
    fixtures_dir = Path(__file__).parent / "fixtures"
    return fixtures_dir / f"{name}.jsonl"
