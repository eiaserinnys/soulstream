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

## PR 3 서버 명령의 증거 단계

각 명령은 잠긴 카드와 지금까지 모은 증거로 결정 기계에 묻는다. ordered reject 전이에서 앞선 거절이 없고 다음 증거가 없으면 needsEvidence가 읽을 단계를 지목한다. 서비스는 지목된 reader만 실행한다. needsEvidence에는 쓰기와 formatter가 없으며, 마지막 apply, noop, reject 뒤에만 decoder와 저장기를 실행한다. 호출 상한은 아래 단계 수 + 1이다. 없는 단계의 증거는 facts에서 생략한다.

| 명령과 서비스 | 증거 단계 순서 | 유지한 SQL 잠금과 생략 조건 |
| :-- | :-- | :-- |
| START_WORK, startCardWork | execution → workAdmission → claim | 실행 등록 sessions FOR SHARE → 활성 dispatch FOR UPDATE → 해당 delivery/등록 receipt → admitted fence JOIN. 수락된 자동 실행이면 claim 조회를 생략한다. 그 밖에는 기존 claimableCardSessions SELECT를 한 번 읽는다. |
| CONFIRM_EXECUTION, recordExecution | executionSession → executionStatus | 요청 세션의 card_id를 sessions FOR SHARE로 읽은 뒤 담당 일치를 판정한다. 일치할 때만 카드 상태 변경 시각과 요청 updated_at을 기존 SQL로 비교한다. |
| DISPATCH, recordDispatch | pending → policy → admission | queued 거절 뒤에는 읽지 않는다. pending SELECT → 정책의 잠금 없는 SELECT → 정책 FOR SHARE → decided run FOR UPDATE → 용량 advisory lock → card_dispatch FOR SHARE → 점유 세션 → 대상 자격 SELECT 순이다. |
| RESUME_LONG_LIMIT, resumeDispatchedCard | pending → policy → admission | 현재 긴 한도 예약 거절 뒤에는 읽지 않는다. 이후 순서와 잠금은 DISPATCH와 같다. |
| BLOCK_FOR_LIMIT, blockCardForLimit | termination → limitReset | 현재 실행 중 담당 판정 뒤 sessions FOR SHARE. 최신 한도 종료와 event ID가 일치할 때만 기존 events 구간 SELECT와 readLimitAutoResumeAt 계산을 수행한다. |
| RESUME_SHORT_LIMIT, resumeLimitedCard | pending | 상태, 담당, 예약 시각 일치와 도래 판정 뒤에만 pending SELECT. 시각 바로 전에는 거절하고 같은 시각부터 허용한다. |
| RESUME_VERIFICATION, resumeVerificationCard | 없음 | 잠긴 카드의 담당과 wake_at 일치만 판정한다. 도래 선별과 실제 깨우기는 기존 호출부에 남는다. |
| NOTE_MISSING, noteMissingAssignee | 없음 | 상태 자격 제한을 추가하지 않고 blocked_detail만 요청 쓰기로 넘긴다. |

모든 행의 앞에는 기존 mutateCard의 cards FOR UPDATE와 expectedVersion 검사가 있다. 잠금 대상, 모드, 읽는 순서와 트랜잭션 경계는 바꾸지 않는다. 실행 영수증에 따른 dispatch running UPDATE와 허가 dispatch INSERT는 최종 apply 뒤 실행하고, 기존처럼 카드 UPDATE보다 앞선다. 카드 UPDATE는 모두 patchCardTx를 통하며 decoder의 normalization 쓰기는 넘기지 않는다.

serverCardEvidence는 운영 fence 결과와 고정 관찰의 원시 행에서 같은 증거를 만드는 순수 정본이다. 실행 등록, 영수증, admission run/용량/대상, 현재 한도 종료의 계산을 fixture adapter에서 옮겼다. SQL이 보장하는 실행 등록·receipt 상관관계·정책 version·lease·admittedCardVersion fence는 기존 SQL에 남는다. 원시 행에서의 fence 결과 재구성과 운영 결과를 같은 증거 형식으로 묶는다. 한도 해제 시각은 기존 readLimitAutoResumeAt의 결과이며 관찰 fixture의 기록 값을 그대로 사용한다.

| 검사 | 기준 50f25bbfc 위치 | 새 위치 |
| :-- | :-- | :-- |
| START_WORK 주체 종류와 세션 ID | 카드 조회·잠금·version 앞 | 단일 CARD_COMMAND_ENTRY_RULES 표를 같은 입구 위치에서 확인 |
| expectedVersion | 카드 FOR UPDATE 직후 | 기존 mutateCard 그대로 |
| 현재 카드 상태·담당·예약·도래 | 해당 메서드의 첫 증거 SQL 앞 | 기계 ordered reject의 해당 needsEvidence 앞 |
| 실행 등록·자동 실행 admission | 등록 SQL → 영수증 SQL → fence, claim 앞 | execution과 workAdmission 단계 결과를 같은 순서의 가드로 판정 |
| pending·정책·허가 첫 실패 | 각각의 다음 읽기 앞 | 단계 결과를 받은 ordered reject, 다음 needsEvidence 앞 |
| 한도 상세·now, 재개 now 서식 | 상태와 증거 검사 뒤, patch 앞 | 선택된 decoder bind의 이름별 lazy 함수 |

정책은 두 번 읽는다. 처음 잠금 없는 조회가 꺼짐이면 admission 입력을 422 INVALID_CARD_REQUEST로 거절한다. 처음 켜짐, 다음 FOR SHARE 조회가 꺼짐이면 lockedPolicyDisabled fence 결과를 골라 statusCode와 code 없는 기존 Error를 만든다. 두 읽기를 합치거나 잠금 시점을 앞당기지 않는다. 이 경합의 오류 형식 차이는 기존 결함 후보로 남겼다. stale, missingCapacity, capacity, ineligible도 첫 fence 실패만 돌려주며 기존 일반 Error 형식을 유지한다.

card-server-order.test.ts의 SQL prefix와 오류 기대값은 50f25bbfc의 실제 서비스 및 두 SQL fence 모듈을 별도 임시 모듈로 불러 확인한다. 새 서비스에도 같은 기대값을 적용한다. 기존 서비스 시험의 기대값과 관찰 fixture는 바꾸지 않는다.

## 공유 경계와 관찰 범위

모든 mutation의 카드 존재, expectedVersion, idempotency는 before, command와 operations로 확인한다. folders는 폴더 존재와 보관을 기록한다. 단일 담당 제약은 cards, 순서 키 입력도 cards에 있다. 순서 키와 감사 ID 및 시각 자체는 기존 정규화 비교를 따른다. claim은 SQL 조회 결과를 그대로 기록한다.

assertPolicyAdmission은 orchestration 설정, decided run의 lease와 결정, dispatch 설정의 nodeConcurrency, cardCapacitySessions 결과, 카드/폴더 보관과 담당 worker 일치를 읽는다. capacitySessions가 내부에서 읽는 전체 dispatch 및 operation 이력은 해당 SQL의 원시 결과로 축약한다. acceptQueuedWork의 소비 영수증 경로는 활성 dispatch의 delivery와 최신 해당 등록 receipt를 담고, 신규 실행 경로는 admission 이후의 receipt를 담는다. 설정의 card_orchestration 행은 없으면 null이다.

첨부 URL 검증은 카드 상태 결정 밖의 기존 경계다. 위 메서드가 본문/요청을 쓰면 validateCardSourceRefsTx와 resolveCardLegacySourceRefsTx가 조건부로 file_assets, attachment_legacy_aliases, sessions와 cards를 읽는다. 고정 world/cases에는 내부 첨부 및 legacy URL이 없어서 해당 SQL 분기는 실행되지 않는다. assets는 현재 행을 기록한다. legacy alias를 만드는 world 어휘는 없으며 관찰을 새로 발명하지 않는다. 폴더 ACL 콜백은 기존 하니스가 허용하는 입력이고 부수 효과 및 판 metadata는 결정 함수의 합격 비교 범위 밖이다.

질문 답/철회의 남은 질문 조회는 같은 트랜잭션의 선행 질문 UPDATE를 본다. 원시 beforeQuestions와 명령으로 그 한 행의 변화를 정확히 정할 수 있으므로 트랜잭션 전용 외부 증거가 필요하지 않다. 나머지 판정 읽기는 수집 전후에 다른 writer가 없는 이 격리 시험에서 호출 전 조회할 수 있다. 서비스의 locking/검증 SQL을 수집기로 옮기거나 실행하지 않는다.
