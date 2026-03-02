# 마이그레이션 가이드: 파일 모드 → 세렌디피티 모드

이 문서는 Soulstream을 파일 모드에서 세렌디피티 모드로 마이그레이션하는 방법을 설명합니다.

## 개요

| 구분 | 파일 모드 | 세렌디피티 모드 |
|------|-----------|-----------------|
| 저장소 | 로컬 파일 시스템 | 세렌디피티 DB |
| 실시간 업데이트 | SSE | 폴링 |
| 메타데이터 | 수동 | 자동 생성 |
| 의존성 | 없음 | 세렌디피티 서버 |

## 사전 준비

### 1. 세렌디피티 서버 설치

```bash
# 세렌디피티 프로젝트 클론
git clone <serendipity-repo>
cd serendipity

# 의존성 설치 및 시작
npm install
npm run dev
```

기본 포트: `4002`

### 2. 세렌디피티 연결 확인

```bash
curl http://localhost:4002/api/pages
```

빈 배열 `[]`이 반환되면 정상입니다.

## Soul Server 설정

### 환경 변수 변경

**파일 모드 (이전)**

```env
# SERENDIPITY_ENABLED=false (기본값)
```

**세렌디피티 모드 (이후)**

```env
SERENDIPITY_ENABLED=true
SERENDIPITY_URL=http://localhost:4002
```

### 설정 확인

```bash
cd soul-server
source .venv/bin/activate
python -c "from soul_server.config import get_settings; s = get_settings(); print(f'Serendipity: {s.serendipity_enabled}, URL: {s.serendipity_url}')"
```

## Soul Dashboard 설정

### 환경 변수 변경

```env
STORAGE_MODE=serendipity
SERENDIPITY_URL=http://localhost:4002
```

## 데이터 마이그레이션

### 기존 데이터 정책

파일 모드에서 생성된 기존 세션 데이터는 **자동으로 마이그레이션되지 않습니다**.

옵션:
1. **병행 운영**: 기존 데이터는 파일 시스템에 유지, 새 세션만 세렌디피티에 저장
2. **수동 마이그레이션**: 필요한 세션만 수동으로 세렌디피티에 재생성
3. **클린 스타트**: 기존 데이터 보관 후 새로 시작

### 병행 운영 주의사항

- 대시보드는 한 번에 하나의 저장소만 조회 가능
- `STORAGE_MODE`에 따라 표시되는 세션이 다름
- 모드 전환 시 대시보드 재시작 필요

## 검증

### 1. 세션 생성 테스트

세렌디피티 모드에서 새 세션을 실행하고 세렌디피티에서 확인:

```bash
curl http://localhost:4002/api/pages | jq '.[0]'
```

`🤖 Session | ...` 형식의 페이지가 생성되어야 합니다.

### 2. 자동 메타데이터 확인

세션 종료 후 페이지에 다음이 자동 부착됩니다:
- 완료 상태 (✅ 또는 ❌)
- 자동 생성된 제목
- 카테고리 라벨 (🔧 코드 작업, 🐛 디버깅 등)
- 날짜 레이블 (📅 2026년 3월 2일)

### 3. 대시보드 확인

세렌디피티 모드 대시보드에서 세션 목록이 표시되는지 확인합니다.

## 롤백

세렌디피티 모드에서 문제가 발생하면 환경 변수를 변경하여 파일 모드로 롤백:

```env
SERENDIPITY_ENABLED=false
STORAGE_MODE=file
```

서버/대시보드 재시작 후 파일 모드로 동작합니다.

## 문제 해결

### 세렌디피티 연결 실패

```
ERROR:soul_server.service.serendipity_adapter:start_session() failed: ...
```

**해결:**
1. 세렌디피티 서버 실행 중인지 확인
2. `SERENDIPITY_URL` 올바른지 확인
3. 방화벽/네트워크 확인

### 세션은 생성되나 라벨 부착 실패

```
WARNING:soul_server.service.serendipity_adapter:Failed to attach category label...
```

**해결:**
- 세렌디피티 라벨 API 정상 동작 확인
- 레이블 이름에 특수문자 확인

### 대시보드에서 세션이 보이지 않음

**해결:**
1. `STORAGE_MODE=serendipity` 설정 확인
2. 세렌디피티 URL 일치 확인
3. 브라우저 캐시 클리어
