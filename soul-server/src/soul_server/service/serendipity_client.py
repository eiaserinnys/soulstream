"""Serendipity API 비동기 클라이언트

세렌디피티 REST API와 비동기로 통신하는 클라이언트 모듈.
aiohttp 기반으로 구현되어 soul-server의 asyncio 환경과 호환.
"""

import uuid
import logging
from datetime import date
from typing import Any, Dict, List, Optional, TypedDict

import aiohttp

logger = logging.getLogger(__name__)


# ============================================================================
# Types
# ============================================================================

class SerendipityPage(TypedDict):
    """Serendipity 페이지 응답 타입"""
    id: str
    title: str
    createdAt: str
    updatedAt: str


class SerendipityBlock(TypedDict):
    """Serendipity 블록 응답 타입"""
    id: str
    pageId: str
    type: str
    content: Dict[str, Any]
    order: int
    parentId: Optional[str]
    createdAt: str
    updatedAt: str


class PortableTextSpan(TypedDict):
    """Portable Text 스팬"""
    _key: str
    _type: str  # 'span'
    text: str
    marks: List[str]


class PortableTextBlock(TypedDict):
    """Portable Text 블록"""
    _key: str
    _type: str  # 'block'
    style: str  # 'normal', 'h1', 'h2', etc.
    children: List[PortableTextSpan]
    markDefs: List[Dict[str, Any]]


class SerendipityContent(TypedDict):
    """세렌디피티 블록 컨텐츠 (DB 저장 형태)"""
    _version: int  # 1
    content: List[PortableTextBlock]


# ============================================================================
# Content Helpers
# ============================================================================

def generate_key() -> str:
    """고유 키 생성 (8자 알파벳 숫자)"""
    return uuid.uuid4().hex[:8]


def create_text_content(text: str, style: str = 'normal') -> SerendipityContent:
    """
    단순 텍스트로 SerendipityContent 생성

    Args:
        text: 텍스트 내용
        style: 블록 스타일 ('normal', 'h1', 'h2', etc.)

    Returns:
        SerendipityContent 구조
    """
    return {
        "_version": 1,
        "content": [
            {
                "_key": generate_key(),
                "_type": "block",
                "style": style,
                "children": [
                    {
                        "_key": generate_key(),
                        "_type": "span",
                        "text": text,
                        "marks": []
                    }
                ],
                "markDefs": []
            }
        ]
    }


def create_soul_content(
    text: str,
    soul_metadata: Dict[str, Any],
    style: str = 'normal'
) -> Dict[str, Any]:
    """
    Soul 블록용 컨텐츠 생성 (Portable Text + soul 메타데이터)

    Args:
        text: 텍스트 내용
        soul_metadata: soul 전용 메타데이터 (nodeId, timestamp, toolName 등)
        style: 블록 스타일

    Returns:
        확장된 SerendipityContent 구조 (soul 필드 포함)
    """
    content = create_text_content(text, style)
    content["soul"] = soul_metadata
    return content


# ============================================================================
# Date Formatting
# ============================================================================

def format_date_korean(d: date) -> str:
    """날짜를 한글 형식으로 포맷 (예: 2026년 3월 1일)"""
    return f"{d.year}년 {d.month}월 {d.day}일"


def date_label_title(d: date) -> str:
    """일별 날짜 레이블 제목 생성 (예: 📅 2026년 3월 1일)"""
    return f"📅 {format_date_korean(d)}"


# ============================================================================
# Async Serendipity Client
# ============================================================================

class AsyncSerendipityClient:
    """
    Serendipity REST API 비동기 클라이언트

    Usage:
        async with AsyncSerendipityClient("http://localhost:4002") as client:
            page = await client.find_or_create_page("My Page")
            await client.create_block(page["id"], create_text_content("Hello!"))
    """

    def __init__(
        self,
        base_url: str = "http://localhost:4002",
        timeout: float = 30.0,
        max_retries: int = 3,
    ):
        """
        Serendipity API 클라이언트 초기화

        Args:
            base_url: Serendipity 서버 URL (기본값: http://localhost:4002)
            timeout: 요청 타임아웃 (초)
            max_retries: 최대 재시도 횟수
        """
        self.base_url = base_url.rstrip('/')
        self.api_url = f"{self.base_url}/api"
        self._timeout = aiohttp.ClientTimeout(total=timeout)
        self._max_retries = max_retries
        self._session: Optional[aiohttp.ClientSession] = None

    async def __aenter__(self) -> "AsyncSerendipityClient":
        """컨텍스트 매니저 진입"""
        self._session = aiohttp.ClientSession(
            timeout=self._timeout,
            headers={"Content-Type": "application/json"}
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """컨텍스트 매니저 종료"""
        if self._session:
            await self._session.close()
            self._session = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        """세션이 없으면 생성"""
        if self._session is None:
            self._session = aiohttp.ClientSession(
                timeout=self._timeout,
                headers={"Content-Type": "application/json"}
            )
        return self._session

    async def _request(
        self,
        method: str,
        endpoint: str,
        **kwargs
    ) -> Dict[str, Any]:
        """
        HTTP 요청 실행 (재시도 포함)

        Args:
            method: HTTP 메서드 (GET, POST, PATCH, DELETE)
            endpoint: API 엔드포인트 (/pages, /blocks, etc.)
            **kwargs: aiohttp 요청에 전달할 추가 인자

        Returns:
            응답 JSON

        Raises:
            aiohttp.ClientError: HTTP 오류 발생 시
        """
        session = await self._ensure_session()
        url = f"{self.api_url}{endpoint}"

        last_error = None
        for attempt in range(self._max_retries):
            try:
                async with session.request(method, url, **kwargs) as response:
                    response.raise_for_status()
                    if response.content_type == 'application/json':
                        return await response.json()
                    return {}
            except aiohttp.ClientError as e:
                last_error = e
                if attempt < self._max_retries - 1:
                    logger.warning(
                        f"Request failed (attempt {attempt + 1}/{self._max_retries}): "
                        f"{method} {url} - {e}"
                    )
                    continue
                raise

        raise last_error  # type: ignore

    # ========== Page Operations ==========

    async def get_all_pages(self) -> List[SerendipityPage]:
        """모든 페이지 목록 조회"""
        return await self._request("GET", "/pages")

    async def get_page(self, page_id: str) -> Optional[Dict[str, Any]]:
        """
        페이지 조회 (블록 포함)

        Args:
            page_id: 페이지 UUID

        Returns:
            페이지 정보 (blocks 포함) 또는 None
        """
        try:
            return await self._request("GET", f"/pages/{page_id}")
        except aiohttp.ClientResponseError as e:
            if e.status == 404:
                return None
            raise

    async def search_pages(self, query: str) -> List[SerendipityPage]:
        """
        페이지 검색 (제목 기준, 대소문자 무시)

        Args:
            query: 검색어

        Returns:
            매칭되는 페이지 목록
        """
        return await self._request("GET", "/pages/search", params={"q": query})

    async def find_page(self, title: str) -> Optional[SerendipityPage]:
        """
        제목으로 페이지 찾기 (정확히 일치)

        Args:
            title: 페이지 제목

        Returns:
            페이지 정보 또는 None
        """
        pages = await self.search_pages(title)
        for page in pages:
            if page["title"] == title:
                return page
        return None

    async def create_page(self, title: str) -> SerendipityPage:
        """
        새 페이지 생성

        Args:
            title: 페이지 제목

        Returns:
            생성된 페이지 정보
        """
        page = await self._request("POST", "/pages", json={"title": title})
        logger.info(f"create_page(): page '{title}'({page['id']}) created")
        return page

    async def find_or_create_page(self, title: str) -> SerendipityPage:
        """
        페이지 찾기 또는 생성

        Args:
            title: 페이지 제목

        Returns:
            페이지 정보
        """
        page = await self.find_page(title)
        if page:
            logger.info(f"find_or_create_page(): page '{title}'({page['id']}) found")
            return page

        logger.info(f"find_or_create_page(): page '{title}' not found, creating...")
        return await self.create_page(title)

    async def update_page(self, page_id: str, title: str) -> SerendipityPage:
        """
        페이지 제목 업데이트

        Args:
            page_id: 페이지 UUID
            title: 새 제목

        Returns:
            업데이트된 페이지 정보
        """
        return await self._request(
            "PATCH",
            f"/pages/{page_id}",
            json={"title": title}
        )

    # ========== Block Operations ==========

    async def get_blocks(self, page_id: str) -> List[SerendipityBlock]:
        """
        페이지의 모든 블록 조회

        Args:
            page_id: 페이지 UUID

        Returns:
            블록 목록
        """
        result = await self._request("GET", f"/blocks/pages/{page_id}/blocks")
        return result.get("blocks", [])

    async def get_block(self, block_id: str) -> Optional[SerendipityBlock]:
        """
        블록 조회

        Args:
            block_id: 블록 UUID

        Returns:
            블록 정보 또는 None
        """
        try:
            return await self._request("GET", f"/blocks/{block_id}")
        except aiohttp.ClientResponseError as e:
            if e.status == 404:
                return None
            raise

    async def create_block(
        self,
        page_id: str,
        content: Dict[str, Any],
        block_type: str = "paragraph",
        parent_id: Optional[str] = None,
        order: Optional[int] = None
    ) -> SerendipityBlock:
        """
        새 블록 생성

        Args:
            page_id: 페이지 UUID
            content: SerendipityContent (Portable Text 기반)
            block_type: 블록 타입 (기본값: paragraph, 또는 soul:* 타입)
            parent_id: 부모 블록 UUID (선택)
            order: 정렬 순서 (선택)

        Returns:
            생성된 블록 정보
        """
        data: Dict[str, Any] = {
            "pageId": page_id,
            "type": block_type,
            "content": content
        }

        if parent_id:
            data["parentId"] = parent_id
        if order is not None:
            data["order"] = order

        block = await self._request("POST", "/blocks", json=data)

        # 컨텐츠 요약 로깅
        text_preview = self._extract_text_preview(content)
        logger.debug(f"create_block(): block '{text_preview}'({block['id']}) created")

        return block

    async def update_block(
        self,
        block_id: str,
        content: Optional[Dict[str, Any]] = None,
        block_type: Optional[str] = None,
        parent_id: Optional[str] = None,
        order: Optional[int] = None
    ) -> SerendipityBlock:
        """
        블록 업데이트

        Args:
            block_id: 블록 UUID
            content: 새 컨텐츠 (선택)
            block_type: 새 타입 (선택)
            parent_id: 새 부모 블록 ID (선택)
            order: 새 정렬 순서 (선택)

        Returns:
            업데이트된 블록 정보
        """
        data: Dict[str, Any] = {}
        if content is not None:
            data["content"] = content
        if block_type is not None:
            data["type"] = block_type
        if parent_id is not None:
            data["parentId"] = parent_id
        if order is not None:
            data["order"] = order

        return await self._request("PATCH", f"/blocks/{block_id}", json=data)

    async def delete_block(self, block_id: str) -> bool:
        """
        블록 삭제

        Args:
            block_id: 블록 UUID

        Returns:
            True (성공)
        """
        await self._request("DELETE", f"/blocks/{block_id}")
        return True

    # ========== Label Operations ==========

    async def get_labels(self, page_id: str) -> List[Dict[str, Any]]:
        """
        페이지의 모든 레이블 조회

        Args:
            page_id: 페이지 UUID

        Returns:
            레이블 목록
        """
        try:
            return await self._request("GET", f"/pages/{page_id}/labels")
        except Exception as e:
            logger.error(f"get_labels() failed: {e}")
            return []

    async def add_label(self, page_id: str, name: str) -> Optional[Dict[str, Any]]:
        """
        페이지에 레이블 추가

        세렌디피티의 addLabelWithHierarchy()를 호출하여
        날짜 레이블인 경우 상위 계층 자동 생성

        Args:
            page_id: 페이지 UUID
            name: 레이블 이름

        Returns:
            생성된 레이블 정보 또는 None (이미 존재)
        """
        try:
            label = await self._request(
                "POST",
                f"/pages/{page_id}/labels",
                json={"name": name}
            )
            logger.info(f"add_label(): label '{name}' added to page {page_id}")
            return label
        except aiohttp.ClientResponseError as e:
            if e.status == 409:
                # 레이블이 이미 존재함 - 정상 상황
                logger.debug(f"add_label(): label '{name}' already exists on page {page_id}")
                return None
            logger.error(f"add_label() failed: {e}")
            raise

    async def has_label(self, page_id: str, label_name: str) -> bool:
        """
        페이지에 특정 레이블이 있는지 확인

        Args:
            page_id: 페이지 UUID
            label_name: 레이블 이름

        Returns:
            True면 레이블 존재
        """
        labels = await self.get_labels(page_id)
        return any(label.get("name") == label_name for label in labels)

    async def ensure_label(self, page_id: str, name: str) -> Optional[Dict[str, Any]]:
        """
        페이지에 레이블이 없으면 추가

        이미 존재하면 아무것도 하지 않음

        Args:
            page_id: 페이지 UUID
            name: 레이블 이름

        Returns:
            생성된 레이블 정보 또는 None (이미 존재)
        """
        if await self.has_label(page_id, name):
            return None
        return await self.add_label(page_id, name)

    # ========== Utility Methods ==========

    @staticmethod
    def _extract_text(content: Dict[str, Any]) -> str:
        """SerendipityContent에서 평문 추출"""
        if not content or "_version" not in content:
            return ""

        parts = []
        for block in content.get("content", []):
            if block.get("_type") == "block":
                for child in block.get("children", []):
                    if child.get("_type") == "span":
                        parts.append(child.get("text", ""))

        return "".join(parts)

    def _extract_text_preview(self, content: Dict[str, Any], max_len: int = 50) -> str:
        """SerendipityContent에서 미리보기 텍스트 추출"""
        text = self._extract_text(content)
        if len(text) > max_len:
            return text[:max_len] + "..."
        return text

    async def close(self) -> None:
        """
        클라이언트 종료
        """
        if self._session:
            await self._session.close()
            self._session = None
        logger.info("AsyncSerendipityClient session closed")
