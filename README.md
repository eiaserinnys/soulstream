# Soulstream

Soulstream은 Claude Code 세션을 원격으로 호스팅하는 서버입니다. 세션 생성, SSE 스트리밍, 크레덴셜 관리, 러너 풀 예열 등을 통해 Claude Code를 서비스로 제공하며, 슬랙봇이나 다른 클라이언트가 HTTP/SSE로 연결하여 AI 세션을 위임할 수 있습니다.

## 구조

```
soulstream/
├── soul-server/          # FastAPI 실행 서버 (Python)
└── unified-dashboard/    # React 통합 대시보드 (TypeScript)
```

## 아키텍처: 듀얼 모드 저장소

Soulstream은 두 가지 저장 모드를 지원합니다:

### 파일 모드 (기본)

```
SERENDIPITY_ENABLED=false
```

- 세션 데이터를 로컬 파일 시스템에 저장
- 세렌디피티 서버 불필요
- 단독 배포 가능

### 세렌디피티 모드

```
SERENDIPITY_ENABLED=true
SERENDIPITY_URL=http://localhost:4002
```

- 세션 데이터를 세렌디피티에 저장
- 블록 기반 계층 구조로 대화 기록
- 자동 메타데이터 생성 (제목, 카테고리 라벨)
- 날짜별 레이블 자동 부착

### 블록 타입 매핑 (세렌디피티 모드)

| SSE Event | Block Type | 설명 |
|-----------|------------|------|
| prompt (최초) | `soul:user` | 사용자 프롬프트 |
| TextDeltaSSEEvent | `soul:response` | Claude 응답 텍스트 |
| ToolStartSSEEvent | `soul:tool-call` | 도구 호출 시작 |
| ToolResultSSEEvent | `soul:tool-result` | 도구 실행 결과 |
| InterventionSentEvent | `soul:intervention` | 사용자 개입 |
| ErrorEvent | `soul:system` | 시스템 오류 |

## 빠른 시작

### soul-server

```bash
cd soul-server
python -m venv .venv
source .venv/bin/activate   # Linux/Mac
# .venv\Scripts\activate    # Windows
pip install -r requirements.txt
python -m soul_server.main
```

### unified-dashboard

```bash
cd unified-dashboard
pnpm install
pnpm run dev
```

## 환경 변수

### soul-server

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `WORKSPACE_DIR` | (필수) | Claude Code 작업 디렉토리 |
| `SERENDIPITY_ENABLED` | `true` | 세렌디피티 모드 활성화 |
| `SERENDIPITY_URL` | `http://localhost:4002` | 세렌디피티 API URL |
| `PORT` | `3105` | 서버 포트 |

전체 목록은 `soul-server/.env.example` 참조
