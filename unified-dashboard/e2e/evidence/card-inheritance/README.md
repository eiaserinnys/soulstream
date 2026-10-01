# 웹 카드의 기존 요소 상속 검증

카드가 폴더 작업 화면의 오버레이로 열리고, 행·말풍선·입력창은 기존 구성 요소를 상속합니다. 기준은 origin/main `f69ca6cb`이며, 1440×1000과 390×1000에서 실제 렌더 좌표를 확인했습니다. 높이에 맞추는 보정과 새 치수·토큰은 없습니다.

## 최종 범위와 증거

| 항목 | 상속한 요소와 확인 결과 |
| :-- | :-- |
| 1. 열기 | `v3-workspace-scrim` / `v3-workspace` 오버레이와 `WorkspaceSessionColumn`을 사용합니다. 1440에서 카드·채팅 위쪽 끝은 모두 y=16이며, 세션을 열기 전후 카드 x=352·폭635.1875는 동일합니다. 390은 폴더 작업 화면의 모바일 대화 전환을 상속합니다. |
| 2. 패널 | `v3-detail-pane`, `v3-folder-header`, `v3-workspace-toolbar`, `v3-detail-scroll`, `v3-detail-section`을 사용합니다. 넓은 화면에서 카드와 폴더 헤더 첫 캡 x=377, 끝 캡 오른쪽 x=962.1875로 차이0입니다. 좁은 화면의 카드 헤더는 x=24와 오른쪽366으로, 폴더 헤더의 기존 좌우 padding24를 그대로 씁니다. 모바일 대화 중 숨겨진 폴더 패널의 0 좌표를 비교 증거로 사용하지 않았습니다. |
| 3. 말풍선 | `UserMessage` / `AssistantMessage`와 동일 채팅 CSS·`useChatTypography`를 사용합니다. 보고와 채팅의 본문14px, padding14px 16px, 모서리가 같으며, 3줄 접힘은 본문 클릭으로 전환됩니다. 별도의 더 보기 버튼 줄은 없습니다. |
| 4. 이미지 | 기존 마크다운 이미지 표현을 `MarkdownImage`로 공유합니다. 썸네일 클릭과 키보드 활성화로 기존 `Dialog`에 원본을 표시하며, 이미지 클릭은 말풍선을 펼치지 않습니다. |
| 5. 입력 | `ChatInputComposer` / `ChatInputEditor` / `PaperclipButton`과 자동 높이를 그대로 사용합니다. 커멘트·오늘·채팅 모두 본문14px/22px·입력 높이38px·안쪽 padding8px 0입니다. 전송 버튼은 기존 반응형 크기32px(1440) / 36px(390)로 같습니다. 커멘트 첨부는 담당 세션의 기존 업로드 경로를 거쳐 마크다운 URL로 POST합니다. |
| 6. 카드 행 | `RichSessionRow`에서 추출한 `RunRowFrame`의 같은 마크업·클래스·3줄 구성입니다. 초상28px, padding10px, 열 gap8px, trailing 폭64px, 제목14px 토큰과 메타12px가 같습니다. `DashboardIconCap`은44px입니다. 카드 제목 토큰은 기존 세션의14px/20px, 미리보기는14px/21.7px를 유지합니다. |
| 7. 세션 목록 | `RichSessionRow size="small"` / `SessionRunList`를 사용합니다. 초상·padding·gap·trailing·들여쓰기는 기본과 같고 미리보기만 생략합니다. 3개 이후는 N개 더로 접습니다. |
| 8. 겹침 | 카드 목록에 남은 `max-height:min(348px,44dvh)`가 자식 행을 다음 보드 위로 넘치게 했습니다. 상한을 제거하여 자연 높이를 사용합니다. 카드6개 뒤의 보드 간격은 두 화면 모두28px입니다. |
| 9. 섹션 머리 | 프로젝트 컨텍스트의 guidance·atom·기본 에이전트 추가와 카드 추가를 `DashboardIconCap`으로 맞췄습니다. 카드 섹션 제목과 캡의 세로 중심 차이는 두 화면 모두0입니다. |

카드 행의 초상 왼쪽 inset과 trailing 오른쪽 inset은 기본·small 세션 행과 각각11px로 같습니다. 제목 글자의 위쪽 inset은 카드11px, 기본·small12px로 차이1px입니다. 기본 세션의 번호 배지가 제목 줄에 포함되어 생긴 차이이며, 글자 토큰을 덮어쓰지 않았습니다.

## 자연 높이 합산

두 화면에서 같은 높이를 실측했습니다. 기본 세션의 행 높이와 카드 행을 같게 만드는 보정은 없습니다.

| 행 | 실측 높이와 합산 |
| :-- | :-- |
| 카드 | 89 = 테두리2 + 상하 padding20 + max(초상28, 본문63.6875, 시각·캡 열67)입니다. |
| 기본 세션 | 87.6875 = 테두리2 + 상하 padding20 + max(초상28, 본문65.6875, 상태·시각 열45)입니다. |
| small 세션 | 67 = 테두리2 + 상하 padding20 + max(초상28, 두 줄 본문42, 상태·시각 열45)입니다. |

카드와 기본 행의1.3125px 차이는 카드의 시각·44px 캡 열67이 기본 세션의 본문65.6875보다 높아서 생깁니다. small의67px는 상태·시각 열45가 두 줄 본문42보다 높아서 생깁니다.

## 기본 게이트 8개

| 게이트 | 무엇과 같게 했고 어떻게 확인했는지 |
| :-- | :-- |
| 1. 글자 | 기존 세션 행의 제목·메타와 채팅 본문·입력의 토큰을 공유하고 computed fontSize·lineHeight를 대조했습니다. |
| 2. 재사용 | 공유 행 틀, `RichSessionRow` small, 채팅 말풍선·입력창·이미지, 기존 캡·Dialog를 실제 렌더에서 확인했습니다. |
| 3. 여백 | 기본·카드·small 행의 padding10·gap8·trailing64와 채팅 입력 padding8을 같은 좌표 측정으로 확인했습니다. |
| 4. 글자 위치 | 한 줄 입력 본문38 = 위 padding8 + lineHeight22 + 아래 padding8이며, 전송 버튼 크기와 정렬은 채팅과 같습니다. 제목·캡은 flex 가운데 정렬과 중심 좌표를 확인했습니다. |
| 5. 스크롤바 | 폴더 상세 스크롤 클래스를 사용하여 앱 공통 얇은 스크롤바 규칙을 상속했고 두 화면 캡처를 확인했습니다. |
| 6. 포커스 | 입력창의 outline-none·공유 focus ring을 상속했습니다. 새로 클릭되는 카드 행·말풍선·이미지도 기존 ring 유틸리티를 사용합니다. textarea 포커스 시 outline=none과 캡처를 확인했습니다. |
| 7. 표면 | 폴더 상세의 glass surface와 기존 채팅 말풍선의 배경을 재사용했습니다. 카드 전용 accent 반투명 바탕을 제거하고 실제 캡처의 글자 대비를 확인했습니다. |
| 8. 눌러보기 | 상태 단어를 포함한 카드 행 전체가 열리며 상태 mutation은 발생하지 않습니다. 이미지 원본 Dialog, 첨부 업로드·마크다운 URL과 말풍선 접기·펼치기를 E2E로 확인했습니다. |

오늘 입력과 커멘트 입력 모두 별도 onKeyDown·form 제출 경로가 없고, `ChatInputEditor`의 Enter 줄바꿈과 Ctrl/Cmd+Enter 전송을 사용합니다. 각 입력의 키보드 회귀 테스트와 브라우저 커멘트 Enter/Control+Enter 검증을 확인했습니다.

## 캡처

| 상태 | 1440 | 390 |
| :-- | :-- | :-- |
| 오늘 입력·카드 행 | [캡처](after-1440-today.png) | [캡처](after-390-today.png) |
| 카드 오버레이·입력 포커스 | [캡처](after-1440-card.png) | [캡처](after-390-card.png) |
| 세션 클릭 후 | [캡처](after-1440-card-session.png) | [캡처](after-390-card-session.png) |
| 접힌 보고 | [캡처](after-1440-report.png) | [캡처](after-390-report.png) |
| 이미지 원본 | [캡처](after-1440-viewer.png) | [캡처](after-390-viewer.png) |
| 펼친 보고 | [캡처](after-1440-expanded-report.png) | [캡처](after-390-expanded-report.png) |
| 카드6개·보드·섹션 캡 | [캡처](after-1440-folder-cards.png) | [캡처](after-390-folder-cards.png) |
| 기존 폴더 전/후 | [전](before-1440-folder.png) / [후](after-1440-folder.png) | [전](before-390-folder.png) / [후](after-390-folder.png) |
| 기존 채팅 전/후 | [전](before-1440-chat.png) / [후](after-1440-chat.png) | [전](before-390-chat.png) / [후](after-390-chat.png) |

## 불변과 검증

[좌표1440](after-1440-metrics.json) / [좌표390](after-390-metrics.json) / [겹침1440](after-1440-folder-metrics.json) / [겹침390](after-390-folder-metrics.json) / [픽셀 비교](invariance.json).

기본 폴더 세션 행은 두 화면에서 좌표·높이가 그대로이고 해당 영역의 전후 픽셀 차이가0입니다. 채팅은1440의 전체 대화 패널과390의 전체 화면에서 픽셀 차이가0입니다. 전체 폴더 캡처의 차이는 요청한 섹션 머리 아이콘 변경 및 그 주변 배치입니다.

- 최종 카드 상속·커멘트 키 동작 vitest는8 passed입니다.
- 상태 표시·행 열기·완료 정책 vitest는17 passed입니다.
- 오늘 입력의 Enter/Ctrl/Cmd 동작을 포함한 vitest는3 passed입니다.
- 공유 마크다운·채팅 입력·글자 설정 vitest는29 passed입니다.
- 기존 카드 상세·세션 행·인박스·프로젝트 컨텍스트·세션 열·마크다운 표면·시각 계약의 targeted 검증도 통과했습니다.
- 두 패키지 tsc와 최종 dashboard build가 exit0이며, 마지막 브라우저 검증은2 passed (37.3s)입니다.
- 첫 CI에서 채팅 열의 옛 인라인 마운트를 기대하던 stacking 계약1개가 실패했습니다. 실제 `CardWorkspace` 오버레이와 대시보드 연결을 검사하도록 갱신했고 해당 계약은4 passed입니다. 화면 코드는 추가 변경하지 않았습니다.
- 첫 CI smoke에서 오늘 입력의 기존 접근성 이름이 placeholder로 바뀐 것을 확인하여 `세션 첫 메시지` 이름을 복원했습니다. 화면 치수·글자·키 동작은 그대로이며, 수정 후 기존 build+smoke는1 passed (3.4s)입니다.
- build의 기존 caniuse-lite 데이터7개월 경고는 의존성 갱신 범위 밖이므로 그대로 보고합니다.

## 설계와 다르게 한 것

별도 카드 치수를 만들지 않고 기본 세션 행의 공통 틀을 `RunRowFrame`으로 추출했습니다. 기본 채팅의 입력 프레임·이미지 표현·글자 설정도 공유 요소로 추출했으며 기본 렌더 결과는 유지합니다. 채팅에는 원본 확대 뷰어가 없어 지시대로 기존 `Dialog`를 사용합니다. 담당 세션이 없는 카드의 첨부 버튼은 유지하고 곧 지원 안내를 표시합니다.

## 하지 않은 것

서버·API 계약·앱·상태 전이 정책·의존성·토큰 값은 바꾸지 않았습니다. 머지·main 푸시·배포·워크트리 정리는 수행하지 않습니다. 전체 회귀는 기존 CI가 담당합니다.
