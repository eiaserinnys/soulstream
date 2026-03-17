"""
SessionCache - 세션별 이벤트 로컬 캐시

soul-server가 수신한 이벤트를 로컬에 JSONL 형식으로 캐시합니다.
서버 재시작 시에도 캐시된 이벤트를 클라이언트에 즉시 전송할 수 있습니다.

파일 경로: {cache_dir}/{safe_session_id}.jsonl
각 줄: {"id": <monotonic_int>, "event": <event_dict>}
"""

import asyncio
import json
import pathlib
import re
from typing import Optional


class SessionCache:
    """세션별 이벤트 JSONL 캐시."""

    def __init__(self, cache_dir: str):
        self._dir = pathlib.Path(cache_dir)
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, session_id: str) -> pathlib.Path:
        safe = re.sub(r"[^\w.\-]", "_", session_id)
        return self._dir / f"{safe}.jsonl"

    async def append_event(self, session_id: str, event_id: int, event: dict) -> None:
        """이벤트를 세션 캐시에 추가합니다.

        동기 파일 I/O를 asyncio.to_thread로 래핑하여 이벤트 루프 블로킹을 방지합니다.
        """
        line = json.dumps({"id": event_id, "event": event}, ensure_ascii=False)
        path = self._path(session_id)

        def _write():
            with path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")

        await asyncio.to_thread(_write)

    async def read_events(
        self, session_id: str, after_id: Optional[int] = None
    ) -> list:
        """세션의 캐시된 이벤트를 읽습니다.

        동기 파일 I/O를 asyncio.to_thread로 래핑하여 이벤트 루프 블로킹을 방지합니다.

        Args:
            session_id: 세션 식별자
            after_id: 이 ID 이후의 이벤트만 반환 (None이면 전체)

        Returns:
            {"id": int, "event": dict} 항목 리스트
        """
        path = self._path(session_id)
        if not path.exists():
            return []

        def _read():
            results = []
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if after_id is None or item["id"] > after_id:
                    results.append(item)
            return results

        return await asyncio.to_thread(_read)

    async def get_last_event_id(self, session_id: str) -> Optional[int]:
        """세션의 마지막 이벤트 ID를 반환합니다."""
        events = await self.read_events(session_id)
        return events[-1]["id"] if events else None

    async def delete_session(self, session_id: str) -> None:
        """세션 캐시를 삭제합니다."""
        path = self._path(session_id)
        if path.exists():
            path.unlink()
