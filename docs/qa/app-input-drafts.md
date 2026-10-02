# 앱 입력 초안 보존

일반 작성·검색·편집 입력을 앱 종료와 화면 전환 뒤에도 복원합니다. 서버에 저장한 값과 미저장 초안은 구분합니다. 민감한 인증 코드와 첨부 파일은 저장하지 않습니다.

## 저장 계약

`src/store/draftStore.ts`가 기존 `settingsStorage`를 재사용해 AsyncStorage `soul-app-drafts`에 저장합니다. `usePersistentDraft`가 수화 완료 전 입력 변경을 막고, 사용자가 수정한 값만 저장합니다. 서버나 기본값 갱신은 초안을 작성하지 않습니다.

키는 JSON `[serverUrl, decodeAuthJwt(jwt).email, 역할, 대상 배열]`입니다. 기존 인증 사용자 식별 정본을 재사용하며 토큰 원문과 실행 세대를 저장하지 않습니다. 동일 사용자 토큰 갱신에도 복원하고 다른 사용자·서버는 분리합니다. 사용자 식별 전에는 영속 초안을 읽거나 쓰지 않습니다. 미인증 연결 설정만 `["device", "connection-settings"]` scope를 사용합니다.

성공 시 제출한 값과 해당 키의 현재 초안이 같을 때만 제거합니다. 전송 중 새로 쓴 내용은 유지합니다. 실패·단순 닫기·화면 전환은 제거하지 않습니다. 명시적인 편집 취소는 서버값으로 되돌립니다. 서버값이 있는 입력을 빈 문자열로 편집한 경우도 초안으로 보존합니다.

## 입력 인벤토리와 성공 처리

아래 대상 앞에는 공통 서버·사용자 scope가 붙습니다. 같은 폰·태블릿 입력은 같은 키를 사용합니다.

| 운영 입력 / 연결 위치 | 역할 / 대상 | 초안 제거 시점 |
|---|---|---|
| 세션 대화 / ChatBody | chat / nodeId, sessionId | 전달 성공이 확인되고 원문이 동일할 때 |
| 메인 신규 세션 / TodayCardComposer | main-composer / 없음 | 세션 생성·기존 생성 완료 처리 성공 |
| 폴더 카드 맡기기 / CardComposer | folder-compose / folderId | 카드 생성 성공 |
| 카드 커멘트·실제 질문 답변 / CardDetailContent | card-comment / cardId | 커멘트 또는 질문 답변 저장 성공 |
| 카드 제목·요청 / CardCreateSheet | card-create / 호출 folderId 또는 all | 카드 생성 성공 |
| 재실행 사유 / CardStatusMenu | card-reason / cardId | 상태 변경 성공 |
| 선택형 대화 질문 / ChatInputRequest | chat-question / sessionId, requestId 또는 eventId | 응답 성공; 제출 표시만 메모리에 유지 |
| 기존 데일리 메모 / DailyMemo.MemoBlock | daily-memo / blockId | 기존 자동 저장·명시 저장 성공; 태블릿 편집 취소 |
| 신규 데일리 메모 / DailyMemo | daily-memo-new / 날짜, daily pageId | 새 메모 저장 성공 |
| 신규 폴더 제목·설명·초기 지침 / NewFolderSheet | folder-create / 부모 projectPageId 또는 root | 폴더 생성 성공 |
| 프로젝트 지침 / ProjectContextEditorView | project-context / projectPageId | 지침 저장 성공; 명시 편집 취소 |
| 승계 세션 초기 지시 / SessionSuccessionSheet | session-succession / sourceSessionId 또는 folderId | 세션 생성 성공 |
| 반복 작업 모든 입력·cron·시각 / RecurringJobEditor | recurring-job / jobId 또는 new | 폼 저장 성공; 실행·활성화 변경은 편집 초안을 제거하지 않음 |
| 검수 정책 목록·미추가 출처 ID / SessionReviewPolicySettingsSection | review-policy / 없음 | 목록 저장 성공 후 미추가 ID가 없고 폼이 동일할 때 |
| 연결 URL·서버 종류 / SettingsScreen | connection-settings / 기기 | 연결 설정 저장 성공 |
| 일반 세션·메시지 검색 / searchStore, usePersistentSearch | session-search / 없음 | 사용자가 직접 검색어를 비울 때 |
| 폴더 선택기 검색 / FolderSelectionSheet | folder-selection-search / main-composer, card-create:호출 scope, folder-compose:folderId 또는 card:cardId | 사용자가 직접 검색어를 비울 때 |

데일리 API의 `daily`에는 folderId가 없으며 날짜별 전역 page가 대상입니다. 신규 메모는 실제 호출이 쓰는 `daily.page.id`와 날짜로 구분합니다.

일반 검색 query의 실행 중 소유자는 기존 searchStore입니다. 기존 SecureStore 검색 저장에는 query를 추가하지 않습니다. 공통 저장 훅을 앱 인증 경계에서 연결하며 폰 일반 검색 재진입과 태블릿 검색 닫기는 query를 지우지 않습니다.

채팅은 기존 optimistic 표시와 첨부 정리를 유지합니다. 화면 입력은 전송 시작 시 비워지지만 영속 원문은 확인될 때까지 남습니다. 자동 재전송·outbox는 추가하지 않습니다.

메모와 프로젝트 지침은 기존 `mergeServerDraft` 규칙을 유지합니다. 검수 정책 재조회는 기존 `rebaseSourceChanges`로 변경하지 않은 목록은 최신 서버를 따르고 사용자 추가·제거는 유지합니다. 목록 API가 저장하지 않는 미추가 ID는 정책 저장 뒤에도 남습니다.

## 명시적 제외와 현재 미완

| 입력 | 현재 처리 / 근거 |
|---|---|
| ClaudeProviderSection 인증 코드 | 민감 인증 정보이므로 영구 저장 제외 |
| MessageTextSelectionView, MarkdownSelectionInput | 읽기 전용이므로 제외 |
| CardQuestionView | 운영 호출이 없으며 실제 질문 답변은 CardDetailContent에서 처리 |
| 검수 창·proposal의 예시 입력 | 영구 저장 제외 |
| FolderWorkspace 제목·설명 | 선행 완료 목록 PR #1114 머지 후 연결 예정 |
| 신규 완료 목록 검색·기간·시작일·종료일 | 선행 PR #1114 머지 후 전체/폴더ID scope의 폼으로 연결 예정; q·cursor·기간 조회키는 draft 키에 쓰지 않음 |
| iOS Alert.prompt 이름 입력 | 운영 교체는 사용자 승인 대기; 격리 시안만 제공 |

## 이름 변경 격리 시안

`soul-app/proposals/name-input`은 별도의 Expo 프로젝트이며 제품 진입점과 컴포넌트 검수 창에서 import하지 않습니다. 대표 세션 이름 변경만 보여줍니다.

FolderSelectionSheet의 AppModalSurface expanded/pageSheet와 cardStyles content/heading/input/actions, GlassButton을 그대로 사용합니다. CardCreateSheet의 AppKeyboardAvoidingView와 입력·하단 버튼 배치를 재사용하며 새 치수·스타일을 정의하지 않습니다. 닫기·재열기는 시안의 메모리 입력을 유지하고 성공 모의는 지우며 실패 모의는 유지합니다. 검수용 예시는 영구 저장하지 않습니다.

현재 native prompt와 달리 기존 앱 시트 안에서 이름을 편집하고 닫기/저장 버튼을 표시합니다. 실제 iOS Alert.prompt의 before 캡처나 UIKit 키보드 동작은 이 웹 시안에서 확인하지 않았습니다. 승인 후 운영 연결은 별도 확정 사항입니다.

## 검증 증거

독립 입력 연결 후 관련 Jest 9개 suite, 60개 테스트가 통과했습니다. 독립 코드 검수 보완 후 변경 영역만 추가 검증하여 4개 suite, 26개 테스트가 통과했고 앱 `tsc --noEmit`도 종료 코드 0을 확인했습니다. 전체 테스트·앱 빌드·EAS 배포는 실행하지 않았습니다.

핵심 테스트는 재시작 수화, 사용자·서버·대상 격리, 성공 clear와 전송 중 새 입력 보호, 실패·닫기 복원, 서버 텍스트의 빈 편집, 카드 커멘트, 프로젝트 지침, 검수 정책 미추가 ID와 일반 검색 소유자 연결을 확인합니다. 같은 저장 코드를 입력별로 반복 검증하지 않습니다.
