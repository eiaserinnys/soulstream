# 카드 결정 관찰의 SQL 증거 대조

기준: c8b9c745a 서비스, 보강 착수 3656f4e98. 수집기는 서비스 호출 직전 전용 시험 DB를 읽는다. 결정 모듈은 import하지 않는다. 아래는 감싸는 23개 메서드 전체다. before와 beforeQuestions는 원시 행이고, 기존 evidence는 owner, claimableSessions, dispatches, executionRequests, limitAutoResumeAt이다. Tx 입구에서는 첫 인자로 받은 SQL 연결로 before, evidence와 after를 모두 읽는다.

새 evidence.decisionReads는 정책 행(없으면 null), admission run(없으면 null), 활성 dispatch의 dispatchRuns, capacitySessions 조회 결과, sessions, cards, folders, comments, participantRequests, operations, assets, deliveries, registrations, userInputAfterLastReply, executionStatusChanged다. 마지막 두 값은 기존 SQL의 관찰 결과다. 설정, 권한 또는 성공 여부를 수집기가 추정하지 않는다.

| 메서드 | 결과를 가르는 읽기와 도우미 | 기존 기록 | 보강 |
| :-- | :-- | :-- | :-- |
| createCard | prepareCreateCardParams의 생성 세션, lockFolder, position의 카드 순서, assertSingleCardAssignee | command만 있음 | sessions, folders, cards |
| createCardTx | createCard와 같은 prepareCreateCardParams와 createCardMutation | 이전 수집에서 누락 | 전달된 Tx SQL 연결에서 같은 읽기와 생성 결과를 기록 |
| setCardStatus | applyStatusTx, claimableCardSessions, 검증 입력과 담당, position, 공통 patch | before, claimableSessions | cards로 단일 담당 및 순서 경계도 기록 |
| requestCardReview | 항목과 ask, applyStatusTx와 claim, patch | before, command, claimableSessions | cards |
| resumeBlockedCardOnHumanInput | 상태, 보관, 담당, 열린 질문의 조건부 닫기 | before, beforeQuestions | 추가 없음 |
| askQuestion | options, assertNotOtherSessionAssignee, questionCardNow, patch | command, before | cards로 단일 담당 경계 기록 |
| answerQuestion | 대상 질문, UPDATE 결과, 대상 처리 뒤 남은 열린 질문 | beforeQuestions | 처리 뒤 남은 질문은 대상 한 행의 답 저장을 제외해 도출 가능 |
| withdrawQuestion | canWithdrawCardQuestion, 대상 질문, 조건부 UPDATE와 재조회, 남은 열린 질문 | beforeQuestions, actor | 대상 한 행의 철회를 제외해 남은 질문 도출 가능 |
| addComment | prepareAddComment 뒤 spoken이면 assertNotOtherSessionAssignee, 그 뒤 공통 applyAddCommentTx | before, command, claimableSessions, 질문 | comments, userInputAfterLastReply, cards; 다른 담당 오류가 항목의 mode 오류보다 먼저 |
| addCommentTx | prepareAddComment 뒤 applyAddCommentTx; 직접 입구의 다른 담당 검사는 없음 | 이전 수집에서 누락 | dispatch_work accept의 후속 입구를 기록; actor를 유지하고 entrance=followup으로 도출 |
| startCardWork | validateWorkExecution의 요청 세션, acceptQueuedWork의 dispatch, receipt, delivery, run, 설정, worker, claim | owner와 dispatches만 있어 다른 worker 및 receipt 누락 | sessions, registrations, deliveries, admissionRun, 정책 행 |
| recordExecution | 요청 세션 card_id, 카드 status_changed_at과 요청 updated_at 비교, patch | before, executionRequests; 요청 세션 누락 가능 | sessions, executionStatusChanged(서브밀리초 SQL 비교 보존), cards |
| recordDispatch | queued, pending 요청, checkAdmission 및 assertPolicyAdmission | before, executionRequests, dispatches | 정책, run, capacitySessions, cards, folders, sessions |
| blockCardForLimit | 현재 담당 세션의 종료 종류와 event ID, readLimitAutoResumeAt의 events 구간과 reset 시각 | owner와 limitAutoResumeAt에 기존 SQL 결과 있음 | sessions로 요청 세션도 기록; events 구간의 순수 도출 결과는 기존 limitAutoResumeAt 유지 |
| resumeLimitedCard | 상태, 보관, 담당, 기록한 예약과 요청 시각 및 도래, pending | before, command, executionRequests | 추가 없음 |
| resumeDispatchedCard | 상태, 보관, 예약 담당과 시각, pending, checkAdmission | before, command, executionRequests | recordDispatch와 같은 admission 읽기 |
| resumeVerificationCard | 상태, wake_at과 요청 시각, 담당 | before, command | 추가 없음 |
| noteMissingAssignee | 상태 제한 없음; 공통 patch의 예약 정리와 단일 담당 확인 | before | cards |
| bulkSetCardStatus | requireMaintenanceSession, prior operation, 카드, assertBulkStatusGuardTx의 담당 세션, applyStatusTx | 첫 before와 owner만 있음 | 모든 참여 cards와 sessions, operations, participantRequests |
| mergeCards | prior operation, 대상과 모든 원본 카드의 assertUnstartedCardTx, pending, 댓글/노트, 공통 patch | 첫 원본 before만 있음 | cards, folders, operations, participantRequests, comments |
| patchCard | 공통 patch, 단일 담당 충돌, 보관 해제 | before와 command | cards, sessions |
| updateUnstartedCard | prior operation, 카드, assertUnstartedCardTx, pending, request 첨부 | before와 executionRequests | operations, participantRequests, cards, assets |
| saveExecutionSettings | pending, 연결 담당, applyCardMoveTx의 폴더와 순서, 공통 patch | before와 executionRequests | folders, cards, participantRequests |

## 공유 경계와 관찰 범위

모든 mutation의 카드 존재, expectedVersion, idempotency는 before, command와 operations로 확인한다. folders는 폴더 존재와 보관을 기록한다. 단일 담당 제약은 cards, 순서 키 입력도 cards에 있다. 순서 키와 감사 ID 및 시각 자체는 기존 정규화 비교를 따른다. claim은 SQL 조회 결과를 그대로 기록한다.

assertPolicyAdmission은 orchestration 설정, decided run의 lease와 결정, dispatch 설정의 nodeConcurrency, cardCapacitySessions 결과, 카드/폴더 보관과 담당 worker 일치를 읽는다. capacitySessions가 내부에서 읽는 전체 dispatch 및 operation 이력은 해당 SQL의 원시 결과로 축약한다. acceptQueuedWork의 소비 영수증 경로는 활성 dispatch의 delivery와 최신 해당 등록 receipt를 담고, 신규 실행 경로는 admission 이후의 receipt를 담는다. 설정의 card_orchestration 행은 없으면 null이다.

첨부 URL 검증은 카드 상태 결정 밖의 기존 경계다. 위 메서드가 본문/요청을 쓰면 validateCardSourceRefsTx와 resolveCardLegacySourceRefsTx가 조건부로 file_assets, attachment_legacy_aliases, sessions와 cards를 읽는다. 고정 world/cases에는 내부 첨부 및 legacy URL이 없어서 해당 SQL 분기는 실행되지 않는다. assets는 현재 행을 기록한다. legacy alias를 만드는 world 어휘는 없으며 관찰을 새로 발명하지 않는다. 폴더 ACL 콜백은 기존 하니스가 허용하는 입력이고 부수 효과 및 판 metadata는 결정 함수의 합격 비교 범위 밖이다.

질문 답/철회의 남은 질문 조회는 같은 트랜잭션의 선행 질문 UPDATE를 본다. 원시 beforeQuestions와 명령으로 그 한 행의 변화를 정확히 정할 수 있으므로 트랜잭션 전용 외부 증거가 필요하지 않다. 나머지 판정 읽기는 수집 전후에 다른 writer가 없는 이 격리 시험에서 호출 전 조회할 수 있다. 서비스의 locking/검증 SQL을 수집기로 옮기거나 실행하지 않는다.
