# Soul Dashboard

Soulstream 세션 모니터링 대시보드. React Flow 기반 실시간 시각화를 제공합니다.

## 빠른 시작

```bash
npm install
npm run dev
```

## 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev` | 개발 서버 시작 |
| `npm run build` | 프로덕션 빌드 |
| `npm run test` | 단위 테스트 |
| `npm run test:e2e` | E2E 테스트 (Playwright) |

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 대시보드 서버 포트 |
| `SOUL_SERVER_URL` | `http://localhost:3105` | Soul Server API URL |
| `STORAGE_MODE` | `file` | 저장소 모드 (`file` 또는 `serendipity`) |
| `SERENDIPITY_URL` | `http://localhost:4002` | 세렌디피티 API URL (세렌디피티 모드 시) |

## 아키텍처

### 저장소 모드

대시보드는 두 가지 저장소 모드를 지원합니다:

**파일 모드** (`STORAGE_MODE=file`)
- Soul Server의 파일 시스템에서 세션 데이터 조회
- SSE를 통한 실시간 업데이트
- 세렌디피티 서버 불필요

**세렌디피티 모드** (`STORAGE_MODE=serendipity`)
- 세렌디피티에서 세션 데이터 조회
- 폴링을 통한 업데이트
- 블록 기반 계층 구조 시각화
- `soul:*` 블록 타입 지원

### 기술 스택

- **프론트엔드**: React 19, Vite, React Flow
- **백엔드**: Express 5, TypeScript
- **상태 관리**: Zustand
- **테스트**: Vitest, Playwright
