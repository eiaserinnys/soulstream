"""attachmentPaths → extra_context_items 변환 헬퍼."""

from typing import Optional


def build_attachment_context_items(
    attachment_paths: Optional[list[str]],
) -> Optional[list[dict]]:
    """첨부 파일 경로 목록을 extra_context_items 형태로 변환.

    Returns None if attachment_paths is empty/None.
    """
    if not attachment_paths:
        return None
    return [
        {
            "key": "attached_files",
            "label": "첨부 파일",
            "content": (
                "다음 파일들이 첨부되었습니다. Read 도구로 내용을 확인하세요:\n"
                + "\n".join(f"- {p}" for p in attachment_paths)
            ),
        }
    ]
