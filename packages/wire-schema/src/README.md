# @soulstream/wire-schema

소울스트림 노드 ↔ 오케스트레이터 WebSocket 프로토콜의 **단일 정본 스키마**.

## 정본

- `src/upstream.schema.json` — JSON Schema Draft 2020-12. 메시지 정의 81개 (`$defs`).
  - wire 메시지 36종
  - SSE event payload 45종 (`event` 메시지의 `event` 키 안에 packed — orch-server/constants.py KNOWN_SSE_EVENT_TYPES + Agents SDK events)

## 생성물 (직접 편집 금지)

- `generated/python/upstream.py` — `datamodel-code-generator`로 생성한 TypedDict
- `generated/typescript/index.ts` — `json-schema-to-typescript`로 생성한 interface

## 워크플로우

1. `src/upstream.schema.json`을 편집한다.
2. `bash scripts/generate.sh`로 양쪽 generated를 재생성한다.
3. `git add src/ generated/`로 schema와 생성물을 함께 커밋한다.

CI가 `scripts/verify.sh`로 schema ↔ generated 정합을 검증한다.

## 후방호환 정책

모든 메시지 schema는 `additionalProperties: true`. 새 키는 후방호환으로 추가 가능,
삭제·rename은 명시적 마이그레이션 카드를 통해서만.

## 주요 결정 (`20260516-0732-option-d-phase-a-design.md` §2)

- 단일 schema 파일 (메시지 47개가 평탄하므로 분리 가치 0)
- discriminator union (`type` 필드)
- Python TypedDict 출력 (기존 `soul-server/upstream/protocol.py`와 호환)
- TS interface + discriminated union 출력
- `NodeRegister.supported_backends` 신규 top-level 필드 (옵션 D — Codex 백엔드 라우팅 준비)
