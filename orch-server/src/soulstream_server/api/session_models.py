"""
Sessions API Request/Response 모델.

sessions.py 라우터가 사용하는 Pydantic 모델 정의.
"""

from typing import Any, Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

ReasoningEffort = Literal["minimal", "low", "medium", "high", "xhigh"]
ClaudePermissionMode = Literal[
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
    "auto",
]


class CreateSessionRequest(BaseModel):
    # 'profile'과 'agentId' 양쪽을 모두 수용한다.
    # - orch-server 고유 용어: profile (노드 위임 WS 페이로드 키)
    # - soul-server 공용 용어: agentId (동일 값의 다른 이름)
    # 두 서버 API를 대칭으로 유지하여 호출자가 용어를 바꾸지 않아도 동작하게 한다.
    model_config = ConfigDict(populate_by_name=True)

    prompt: str = ""
    nodeId: Optional[str] = None
    folderId: Optional[str] = None
    container: Optional[dict] = None
    sourceRunbookItemId: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("sourceRunbookItemId", "source_runbook_item_id"),
    )
    profile: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("profile", "agentId"),
    )
    allowed_tools: Optional[list[str]] = None
    disallowed_tools: Optional[list[str]] = None
    use_mcp: Optional[bool] = None
    claude_permission_mode: Optional[ClaudePermissionMode] = Field(
        default=None,
        validation_alias=AliasChoices("claudePermissionMode", "claude_permission_mode"),
    )
    system_prompt: Optional[str] = None
    oauth_profile_name: Optional[str] = None
    caller_session_id: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("caller_session_id", "callerSessionId"),
    )
    attachmentPaths: Optional[list[str]] = None
    # Task Tree에서 사용자가 특정 태스크 아래 일반 New Session을 시작할 때 사용한다.
    # 위임 세션이 아니므로 caller_session_id와 분리하고, 서버가 parent task context와
    # child task link를 단일 operation처럼 처리한다.
    parentTaskId: Optional[str] = None
    taskIdempotencyKey: Optional[str] = None
    caller_info: Optional[dict] = None  # 발신자 정보. 비어있으면 서버가 HTTP Request에서 조립한다.
    model: Optional[str] = None
    # Codex 전용. SessionRouter가 backend=codex인 경우에만 노드 wire로 전달한다.
    reasoningEffort: Optional[ReasoningEffort] = None


class InterveneRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    text: str
    user: str = ""
    attachmentPaths: Optional[list[str]] = Field(
        default=None,
        validation_alias=AliasChoices("attachmentPaths", "attachment_paths"),
    )
    context_items: Optional[list[dict]] = Field(
        default=None,
        validation_alias=AliasChoices("context_items", "contextItems"),
    )
    caller_info: Optional[dict] = None  # 발신자 정보. 비어있으면 라우트가 HTTP Request에서 조립.


class RespondRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    request_id: str = Field(alias="requestId")
    answers: dict
    caller_info: Optional[dict] = None


class ClaudeRuntimeBackgroundTasksRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    tool_use_id: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("toolUseId", "tool_use_id"),
    )
    caller_info: Optional[dict] = None


class ToolApprovalRequest(BaseModel):
    message: Optional[str] = None
    alwaysApprove: Optional[bool] = None
    alwaysReject: Optional[bool] = None
    caller_info: Optional[dict] = None


class RealtimeCreateCallRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    offerSdp: str = Field(validation_alias=AliasChoices("offerSdp", "offer_sdp"))
    model: Optional[str] = None
    voice: Optional[str] = None
    instructions: Optional[str] = None
    caller_info: Optional[dict] = None


class RealtimeEventRequest(BaseModel):
    event: dict[str, Any]
    callId: Optional[str] = None
    caller_info: Optional[dict] = None


class RealtimeToolApprovalRequest(BaseModel):
    decision: Literal["approved", "rejected"]
    message: Optional[str] = None
    source: Optional[Literal["tap", "voice"]] = None
    callId: Optional[str] = None
    caller_info: Optional[dict] = None


class RenameSessionRequest(BaseModel):
    displayName: Optional[str] = None
    caller_info: Optional[dict] = None


class SessionCatalogUpdate(BaseModel):
    folderId: Optional[str] = None
    displayName: Optional[str] = None
    caller_info: Optional[dict] = None


class ReadPositionRequest(BaseModel):
    last_read_event_id: int
    caller_info: Optional[dict] = None
