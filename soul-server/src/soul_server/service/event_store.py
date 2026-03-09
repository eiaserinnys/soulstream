"""
Event Store - JSONL 기반 이벤트 저장소

대시보드 재접속 시 이전 이벤트 재생 및 세션 목록 조회를 위한
이벤트 영속화 계층.

각 세션(agent_session_id)의 이벤트를 개별 JSONL 파일로 저장합니다.
파일 형식: {base_dir}/{agent_session_id}.jsonl
각 줄: {"id": <monotonic_int>, "event": <event_dict>}
"""

import json
import logging
import re
import threading
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


class EventStore:
    """JSONL 기반 이벤트 저장소

    Args:
        base_dir: JSONL 파일 저장 디렉토리
    """

    def __init__(self, base_dir: Path) -> None:
        self._base_dir = Path(base_dir)
        self._base_dir.mkdir(parents=True, exist_ok=True)
        # 세션별 다음 ID 캐시 (메모리): key = agent_session_id
        self._next_id: Dict[str, int] = {}
        # 세션별 파일 쓰기 잠금 (defaultdict로 TOCTOU 레이스 방지)
        self._locks: Dict[str, threading.Lock] = defaultdict(threading.Lock)

    def _get_lock(self, key: str) -> threading.Lock:
        return self._locks[key]

    @staticmethod
    def _sanitize_path_component(value: str) -> str:
        """파일명에 안전한 문자만 남긴다 (영숫자, 점, 하이픈, 언더스코어)."""
        return re.sub(r"[^\w.\-]", "_", value)

    def _session_path(self, agent_session_id: str) -> Path:
        """세션의 JSONL 파일 경로를 반환한다.

        플랫 구조: {base_dir}/{agent_session_id}.jsonl
        """
        safe_id = self._sanitize_path_component(agent_session_id)
        path = self._base_dir / f"{safe_id}.jsonl"
        # resolve 후 base_dir 하위인지 확인 (path traversal 방지)
        if not path.resolve().parent.is_relative_to(self._base_dir.resolve()):
            raise ValueError(f"Invalid agent_session_id: {agent_session_id}")
        return path

    def _load_next_id(self, agent_session_id: str) -> int:
        """JSONL 파일에서 마지막 ID를 읽어 다음 ID를 결정한다."""
        if agent_session_id in self._next_id:
            return self._next_id[agent_session_id]

        path = self._session_path(agent_session_id)
        if not path.exists():
            self._next_id[agent_session_id] = 1
            return 1

        # 파일의 마지막 줄에서 ID를 읽는다
        last_id = 0
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        data = json.loads(line)
                        last_id = max(last_id, data.get("id", 0))
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"Failed to read JSONL file {path}: {e}")

        next_id = last_id + 1
        self._next_id[agent_session_id] = next_id
        return next_id

    def append(self, agent_session_id: str, event: dict) -> int:
        """이벤트를 JSONL 파일에 추가한다.

        Args:
            agent_session_id: 세션 식별자
            event: 이벤트 딕셔너리

        Returns:
            부여된 단조증가 ID
        """
        lock = self._get_lock(agent_session_id)

        with lock:
            event_id = self._load_next_id(agent_session_id)
            record = {"id": event_id, "event": event}

            path = self._session_path(agent_session_id)
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

            self._next_id[agent_session_id] = event_id + 1

        return event_id

    def read_all(self, agent_session_id: str) -> List[dict]:
        """세션의 모든 이벤트를 반환한다.

        Args:
            agent_session_id: 세션 식별자

        Returns:
            이벤트 딕셔너리 리스트 (각 항목: {"id": int, "event": dict})
        """
        path = self._session_path(agent_session_id)
        if not path.exists():
            return []

        events = []
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            events.append(json.loads(line))
                        except json.JSONDecodeError:
                            logger.warning(f"Skipping corrupted line in {path}")
                            continue
        except OSError as e:
            logger.warning(f"Failed to read events from {path}: {e}")

        return events

    def read_since(self, agent_session_id: str, after_id: int) -> List[dict]:
        """after_id 이후의 이벤트만 반환한다.

        Last-Event-ID 기반 SSE 재연결 지원.

        Args:
            agent_session_id: 세션 식별자
            after_id: 이 ID 이후의 이벤트만 반환 (이 ID는 포함하지 않음)

        Returns:
            이벤트 딕셔너리 리스트
        """
        all_events = self.read_all(agent_session_id)
        return [ev for ev in all_events if ev["id"] > after_id]

    def cleanup_session(self, agent_session_id: str) -> None:
        """세션의 캐시된 메타데이터를 제거한다.

        TaskManager.ack_task 등에서 호출하여 메모리 누수를 방지한다.
        Lock은 race condition 방지를 위해 유지한다 (다른 스레드가 사용 중일 수 있음).
        """
        self._next_id.pop(agent_session_id, None)
        # Lock은 저렴하므로 제거하지 않음 (race condition 방지)

    def delete_session(self, agent_session_id: str) -> None:
        """세션 데이터와 JSONL 파일을 제거한다.

        Lock은 race condition 방지를 위해 유지한다.
        """
        self.cleanup_session(agent_session_id)
        path = self._session_path(agent_session_id)
        if path.exists():
            try:
                path.unlink()
            except OSError as e:
                logger.warning(f"Failed to delete session file {path}: {e}")

    def list_sessions(self) -> List[dict]:
        """저장된 세션 목록을 반환한다.

        base_dir 직하의 *.jsonl 파일을 스캔한다 (플랫 구조).

        Returns:
            세션 메타데이터 딕셔너리 리스트. 각 항목:
            - agent_session_id: str
            - event_count: int
            - last_event_type: Optional[str]
        """
        sessions = []

        if not self._base_dir.exists():
            return sessions

        for jsonl_file in self._base_dir.glob("*.jsonl"):
            if not jsonl_file.is_file():
                continue

            agent_session_id = jsonl_file.stem  # 확장자 제외

            # 이벤트 수와 마지막 이벤트 타입 가져오기
            event_count = 0
            last_event_type: Optional[str] = None

            try:
                with open(jsonl_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            event_count += 1
                            data = json.loads(line)
                            event = data.get("event", {})
                            last_event_type = event.get("type")
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(f"Failed to read session file {jsonl_file}: {e}")
                continue

            sessions.append({
                "agent_session_id": agent_session_id,
                "event_count": event_count,
                "last_event_type": last_event_type,
            })

        return sessions
