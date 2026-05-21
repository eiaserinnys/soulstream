"""
Sessions API Request/Response 모델.

sessions.py 라우터가 사용하는 Pydantic 모델 정의.
"""

from typing import Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

ReasoningEffort = Literal["minimal", "low", "medium", "high", "xhigh"]


class CreateSessionRequest(BaseModel):
    # 'profile'과 'agentId' 양쪽을 모두 수용한다.
    # - orch-server 고유 용어: profile (노드 위임 WS 페이로드 키)
    # - soul-server 공용 용어: agentId (동일 값의 다른 이름)
    # 두 서버 API를 대칭으로 유지하여 호출자가 용어를 바꾸지 않아도 동작하게 한다.
    model_config = ConfigDict(populate_by_name=True)

    prompt: str = ""
    nodeId: Optional[str] = None
    folderId: Optional[str] = None
    profile: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("profile", "agentId"),
    )
    allowed_tools: Optional[list[str]] = None
    disallowed_tools: Optional[list[str]] = None
    use_mcp: Optional[bool] = None
    system_prompt: Optional[str] = None
    oauth_profile_name: Optional[str] = None
    caller_session_id: Optional[str] = None
    attachmentPaths: Optional[list[str]] = None
    caller_info: Optional[dict] = None  # 발신자 정보. 비어있으면 서버가 HTTP Request에서 조립한다.
    model: Optional[str] = None
    # Codex 전용. SessionRouter가 backend=codex인 경우에만 노드 wire로 전달한다.
    reasoningEffort: Optional[ReasoningEffort] = None


class InterveneRequest(BaseModel):
    text: str
    user: str = ""
    attachmentPaths: Optional[list[str]] = None
    caller_info: Optional[dict] = None  # 발신자 정보. 비어있으면 라우트가 HTTP Request에서 조립.


class RespondRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    request_id: str = Field(alias="requestId")
    answers: dict


class ToolApprovalRequest(BaseModel):
    message: Optional[str] = None
    alwaysApprove: Optional[bool] = None
    alwaysReject: Optional[bool] = None


class RenameSessionRequest(BaseModel):
    displayName: Optional[str] = None


class ReadPositionRequest(BaseModel):
    last_read_event_id: int
