"""soulstream-server 공통 Pydantic 모델."""

from typing import Optional

from pydantic import BaseModel


class BatchMoveRequest(BaseModel):
    sessionIds: list[str]
    folderId: Optional[str] = None
