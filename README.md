# Soulstream

Claude Code 원격 실행 서비스. 세션 관리, SSE 스트리밍, 실시간 대시보드를 제공합니다.

## 구조

```
soulstream/
├── soul-server/      # FastAPI 실행 서버 (Python)
└── soul-dashboard/   # React + Express 대시보드/클라이언트 (TypeScript)
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

### soul-dashboard

```bash
cd soul-dashboard
npm install
npm run dev
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

## Serendipity 플러그인 동기화

Soulstream의 Soul 플러그인을 Serendipity로 동기화하는 스크립트가 포함되어 있습니다.

### 사용법

```bash
cd soulstream

# 기본 실행 (기본 경로: ../serendipity)
./scripts/sync-serendipity-plugin.sh

# 커스텀 경로 지정
./scripts/sync-serendipity-plugin.sh /path/to/serendipity

# 옵션
./scripts/sync-serendipity-plugin.sh -d    # 드라이런 (시뮬레이션)
./scripts/sync-serendipity-plugin.sh -b    # 백업 후 복사
./scripts/sync-serendipity-plugin.sh -f    # 확인 없이 덮어쓰기
```

### 소스 및 타겟 경로

- **소스**: `packages/serendipity-plugin/src/`
- **타겟**: `{serendipity}/packages/web/src/plugins/soul/`

### 아키텍처 원칙

"Serendipity는 Soulstream을 모른다" - Soul 플러그인의 원본은 Soulstream에서 관리하고, Serendipity로 복사합니다.
