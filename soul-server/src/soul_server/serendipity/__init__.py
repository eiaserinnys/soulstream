"""세렌디피티 연동 패키지.

SSE 이벤트를 세렌디피티 블록으로 변환·저장하는 어댑터와 API 클라이언트.
부가 기능이므로 이 패키지 전체를 제거해도 핵심 기능에 영향 없다.
"""

from soul_server.serendipity.adapter import SerendipityAdapter, SessionContext
from soul_server.serendipity.client import AsyncSerendipityClient

__all__ = ["SerendipityAdapter", "SessionContext", "AsyncSerendipityClient"]
