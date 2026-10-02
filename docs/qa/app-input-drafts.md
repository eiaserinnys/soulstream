# 앱 긴 작성 본문 초안 보존

세션 프롬프트·지침처럼 긴 작성 본문을 화면 전환·앱 재시작 뒤에도 이어 씁니다. 같은 폼의 이름·제목·설정은 기존 정책을 유지합니다. 서버 저장 내용과 미저장 초안을 구분합니다.

## 저장 계약

`src/store/draftStore.ts`는 기존 `settingsStorage`를 재사용해 AsyncStorage `soul-app-drafts`에 문자열 본문만 저장합니다. `usePersistentDraft`는 저장소·인증·설정 수화가 끝나기 전 편집을 막고, 사용자 수정만 저장합니다. 서버 내용이나 기본값을 불러오는 동작은 초안을 만들지 않습니다.

영속 키는 JSON `[serverUrl, decodeAuthJwt(jwt).email, 역할, 대상 배열]`입니다. 인증 사용자 식별 정본을 재사용하며 JWT 원문이나 실행 세대를 저장하지 않습니다. 동일 사용자의 토큰 갱신·재시작은 복원하고 다른 서버·사용자·대상은 분리합니다. 사용자 식별 전에는 영속 초안을 읽거나 쓰지 않으며, 메모리 입력은 기존 인증 scope와 입력 대상을 따라 분리합니다.

전송·저장 성공 시 제출한 원문과 해당 키의 현재 초안이 같을 때만 제거합니다. 처리 중 새로 쓴 내용은 유지합니다. 실패·단순 닫기·화면 전환은 초안을 제거하지 않습니다. 명시적인 편집 취소는 초안을 제거하고 서버 값으로 돌아갑니다. 서버 본문을 빈 문자열로 지운 편집도 초안입니다.

## 본문 인벤토리

아래 역할·대상 앞에는 공통 서버·사용자 scope가 붙습니다. 폰·태블릿은 같은 키를 씁니다.

| 운영 입력 / 연결 위치 | 역할 / 대상 | 제거 시점 |
|---|---|---|
| 세션 대화 / ChatBody | chat / nodeId, sessionId | 전달 성공 확인 후 제출 원문 일치 |
| 메인 신규 세션 / TodayCardComposer | main-composer / 없음 | 생성 완료 처리 성공 |
| 폴더 맡기기 / CardComposer | folder-compose / folderId 또는 all | 카드 생성 성공 |
| 카드 커멘트·실제 서술형 질문 답변 / CardDetailContent | card-comment / cardId | 커멘트·답변 저장 성공 |
| 카드 요청 / CardCreateSheet | card-request / 호출 folderId 또는 all | 카드 생성 성공 |
| 서술형 재실행 사유 / CardStatusMenu | card-reason / cardId | 상태 변경 성공 |
| 기존 메모 / DailyMemo.MemoBlock | daily-memo / blockId | 기존 자동·명시 저장 성공 또는 명시 취소 |
| 신규 메모 / DailyMemo | daily-memo-new / 날짜, daily pageId | 새 메모 저장 성공 |
| 폴더 설명 / FolderWorkspace | folder-description / folderId | 설명 저장 성공 또는 태블릿 명시 취소 |
| 새 폴더 설명 / NewFolderSheet | folder-create-description / 부모 projectPageId 또는 root | 폴더 생성 성공 |
| 새 폴더 초기 지침 / InitialFolderContextEditor → NewFolderSheet | folder-create-guidance / 부모 projectPageId 또는 root | 폴더 생성 성공 |
| 프로젝트 지침 / ProjectContextEditorView | project-context / projectPageId | 지침 저장 성공 또는 명시 취소 |
| 승계 초기 지시 / SessionSuccessionSheet | session-succession / sourceSessionId 또는 folderId | 세션 생성 성공 |
| 반복작업 지시 본문 / RecurringJobEditor | recurring-prompt / jobId 또는 new | 폼 저장 성공; 활성화만 바꾸는 동작은 제거하지 않음 |

데일리 API에는 folderId가 없으므로 신규 메모는 실제 날짜별 `daily.page.id`와 날짜로 구분합니다. 날짜는 메모의 대상이며 날짜 필터를 저장하는 기능은 추가하지 않습니다.

대화는 기존 optimistic 표시와 첨부 정리를 유지합니다. 전송 시작 시 화면 입력은 비우되 영속 원문은 전달이 확인될 때까지 남습니다. 자동 재전송·outbox는 추가하지 않습니다. 메모·폴더 설명·프로젝트 지침은 기존 `mergeServerDraft`와 저장 큐 정책을 유지합니다.

## 이번 변경의 제외 범위

이름·제목, 일반·폴더 선택기·완료 목록 검색어와 기간·날짜 필터, 연결 URL, 설정값·출처 ID 목록·cron·시각, 선택형 질문 선택값은 초안 저장을 추가하지 않습니다. 같은 폼에서 카드 제목·폴더 이름·반복작업 이름과 설정은 기존 상태·초기화 정책을 그대로 씁니다.

Claude 인증 코드는 민감 입력으로 저장하지 않습니다. 첨부 파일·토큰도 저장하지 않습니다. 읽기 전용 선택 입력과 운영 호출이 없는 CardQuestionView, 검수용 예시 입력은 제외합니다. 실제 카드 서술형 답변은 CardDetailContent에 연결합니다.

이름 시트 proposal과 승인 요청은 철회했으며 해당 신규 파일은 PR에서 제거했습니다. 완료 목록 PR #1114의 검색·기간·optional wrap 구현은 그대로 유지하며 저장 연결을 추가하지 않습니다.

## 검증 범위와 플랫폼

공통 문자열 저장 훅의 재시작 수화·토큰 갱신·서버/사용자/역할/대상 분리, 수화 전 변경 차단, 실패·닫기 유지와 성공 삭제, 후속 입력 보호, 빈 본문 편집을 검사합니다. 혼합 폼은 실제 카드 생성 화면에서 요청만 복원되고 제목은 기존 빈 값으로 시작하는지 검사합니다. 실제 폴더 화면에서 폰 초안을 태블릿 편집에 복원하고 명시 취소가 서버 값으로 돌아가는지 검사하며 기존 폴더 설명·제목 저장 계약도 함께 확인합니다. 반복작업의 기존 충돌 처리도 영향 검사에 포함합니다.

검증 결과와 캡처는 최종 PR 설명에 기록합니다. 대표 렌더 증거는 실제 운영 컴포넌트의 로컬 fixture를 React Native web으로 렌더한 폰·태블릿 비교이며 iOS 실기기나 배포 확인을 대신하지 않습니다. 전체 테스트·native 빌드·EAS 배포는 실행하지 않습니다. 머지·배포는 부모가 담당하며 별도 EAS 아카이브 보정 PR 포함 확인도 그 경계에서 수행합니다.
