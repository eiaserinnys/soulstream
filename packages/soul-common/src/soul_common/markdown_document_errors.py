"""Markdown document update conflict errors."""

from __future__ import annotations

from typing import Optional


class MarkdownDocumentVersionConflictError(RuntimeError):
    """Raised when a markdown document update uses a stale version token."""

    def __init__(
        self,
        document_id: str,
        expected_version: int,
        actual_version: Optional[int] = None,
    ) -> None:
        self.document_id = document_id
        self.expected_version = expected_version
        self.actual_version = actual_version
        if actual_version is None:
            message = (
                f"markdown document version conflict: {document_id} "
                f"expected version {expected_version}"
            )
        else:
            message = (
                f"markdown document version conflict: {document_id} "
                f"expected version {expected_version}, actual version {actual_version}"
            )
        super().__init__(message)
