"""
Dashboard API Router - /api/* 엔드포인트

soul-dashboard(TypeScript BFF)가 제공하던 /api/ 경로를 soul-server에 직접 내장합니다.
브라우저는 soul-server(포트 4105)에 직접 접근하고,
봇의 기존 Bearer Token 접근 방식(SEOSOYOUNG_SOUL_URL → 4105)은 변경하지 않습니다.

하위 라우터 include 순서 (중요):
- sessions 라우터 내부에서 GET /api/sessions/stream, /api/sessions/folder-counts가
  GET /api/sessions/{session_id}/events보다 먼저 등록되어 있어야 한다.
  그렇지 않으면 고정 경로가 {session_id} path parameter로 매칭됨.
"""

from fastapi import APIRouter

from soul_server.dashboard.routes.config import router as config_router
from soul_server.dashboard.routes.sessions import router as sessions_router
from soul_server.dashboard.routes.llm import router as llm_router

router = APIRouter()

router.include_router(config_router)
router.include_router(sessions_router)
router.include_router(llm_router)
