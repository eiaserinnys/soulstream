"""세션 라우트 요청 body Pydantic 모델."""

from typing import Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class CreateSessionBody(BaseModel):
    # 'agentId'와 'profile' 양쪽을 모두 수용한다.
    # - soul-server 고유 용어: agentId (AgentRegistry 조회 키)
    # - orch-server / cron 공용 용어: profile (동일 값의 다른 이름)
    # 두 서버 API를 대칭으로 유지하여 호출자가 용어를 바꾸지 않아도 동작하게 한다.
    model_config = ConfigDict(populate_by_name=True)

    prompt: str
    agentSessionId: Optional[str] = None
    folderId: Optional[str] = None
    agentId: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("agentId", "profile"),
    )
    use_mcp: bool = True
    attachmentPaths: Optional[list[str]] = None  # 세션 시작 전 업로드된 파일 절대 경로 목록
    caller_session_id: Optional[str] = None  # 발신 세션 ID (완료 시 자동 보고 대상)
    caller_info: Optional[dict] = None  # 발신자 정보. 비어있으면 서버가 HTTP Request에서 조립한다.


class InterveneBody(BaseModel):
    text: str
    user: str
    attachmentPaths: Optional[list] = None
    context_items: Optional[list[dict]] = None
    caller_info: Optional[dict] = None  # 발신자 정보(통합 v1). 비어있으면 라우트가 build_browser_caller_info로 자동 조립.


class RespondBody(BaseModel):
    # snake_case(슬랙봇 등 외부 클라이언트)와 camelCase(대시보드)를 모두 수용한다.
    # Field(alias=...)는 alias→필드 방향, populate_by_name=True는 필드명→필드 방향을
    # 추가로 연다. AliasChoices는 alias가 여러 개일 때 사용하므로 여기서는 불필요.
    # 동일 패턴: orch-server RespondRequest (api/sessions.py:65).
    model_config = ConfigDict(populate_by_name=True)
    request_id: str = Field(alias="requestId")
    answers: dict


class ReadPositionBody(BaseModel):
    last_read_event_id: int


class RenameSessionRequest(BaseModel):
    displayName: Optional[str] = None
