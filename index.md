# 카드 #1787 U17 화면 캡처

| 파일 | 폭(px) | 상태 |
| --- | ---: | --- |
| baseline-pas-toolbar-360.png | 360 | PAS 창 툴바, atom 없음 |
| baseline-pas-toolbar-768.png | 768 | PAS 창 툴바, atom 없음 |
| baseline-pas-toolbar-1280.png | 1280 | PAS 창 툴바, atom 없음 |
| baseline-dashboard-toolbar-360.png | 360 | 기존 대시보드 툴바 |
| baseline-dashboard-toolbar-1280.png | 1280 | 기존 대시보드 툴바 |
| baseline-pas-empty-1280.png | 1280 | PAS 0개: 설정창이 자동으로 열림(기준선) |
| baseline-settings-persistent-1280.png | 1280 | PAS 설정 대화창(기준선) |
| pas-toolbar-360.png | 360 | PAS 창 툴바, atom 있음 |
| pas-toolbar-768.png | 768 | PAS 창 툴바, atom 있음 |
| pas-toolbar-1280.png | 1280 | PAS 창 툴바, atom 있음 |
| dashboard-toolbar-360.png | 360 | 기존 대시보드 툴바 |
| dashboard-toolbar-1280.png | 1280 | 기존 대시보드 툴바 |
| settings-persistent-top-1280.png | 1280 | 설정창 영구 세션 탭, PAS를 고른 채 열림(위쪽) |
| settings-persistent-bottom-1280.png | 1280 | 설정창 영구 세션 탭(아래쪽: 기록과 세션 스토리) |
| settings-coding-agents-1280.png | 1280 | 코딩 에이전트 탭: Codex 연결 안 됨(연결), Antigravity 연결됨(다시 연결) |
| login-codex-url-ready-1280.png | 1280 | 로그인 시트 Codex: 주소 열기와 코드 |
| login-failed-device-code-1280.png | 1280 | 로그인 시트 실패 device_code_disabled |
| login-antigravity-confirm-1280.png | 1280 | 다시 연결 확인줄 |
| login-antigravity-url-ready-1280.png | 1280 | 로그인 시트 Antigravity: 주소 열기와 코드 입력칸 |
| login-verifying-1280.png | 1280 | 로그인 시트 확인 중 |
| login-done-1280.png | 1280 | 로그인 시트 연결되었습니다 |
| login-failed-invalid-code-1280.png | 1280 | 로그인 시트 실패 invalid_code |
| login-codex-url-ready-360.png | 360 | 로그인 시트 Codex, 좁은 폭 |
| pas-empty-manual-1280.png | 1280 | PAS 0개, bootstrap 꺼짐: 영구 세션 만들기 |
| pas-empty-manual-create-1280.png | 1280 | 영구 세션 만들기를 누르면 설정창의 생성 양식 |
| pas-empty-unavailable-1280.png | 1280 | PAS 0개, 연결 필요: 코딩 에이전트 연결 안내(관리자) |
| pas-empty-unavailable-connect-1280.png | 1280 | 코딩 에이전트 연결을 누르면 설정창의 코딩 에이전트 탭 |
| pas-empty-unavailable-360.png | 360 | PAS 0개, 연결 필요: 코딩 에이전트 연결 안내(관리자) |
| pas-empty-creating-1280.png | 1280 | PAS 0개, bootstrap 켜짐: 기본 영구 세션을 만드는 중 |

## 실측 단언

- 통과: PAS 창 툴바 360px atom 단추 있음
- 통과: PAS 창 툴바 360px 가로 넘침 없음
- 통과: PAS 창 툴바 360px 단추 40x40 이상
- 통과: PAS 창 툴바 768px atom 단추 있음
- 통과: PAS 창 툴바 768px 가로 넘침 없음
- 통과: PAS 창 툴바 768px 단추 40x40 이상
- 통과: PAS 창 툴바 1280px atom 단추 있음
- 통과: PAS 창 툴바 1280px 가로 넘침 없음
- 통과: PAS 창 툴바 1280px 단추 40x40 이상
- 통과: 대시보드 툴바 360px atom 단추 있음
- 통과: 대시보드 툴바 360px 가로 넘침 없음
- 통과: 대시보드 툴바 360px 단추 40x40 이상
- 통과: 대시보드 툴바 1280px atom 단추 있음
- 통과: 대시보드 툴바 1280px 가로 넘침 없음
- 통과: 대시보드 툴바 1280px 단추 40x40 이상
- 통과: 설정창 persistent 탭: 요청한 PAS를 고른 채 다섯 절이 모두 보임
- 통과: 설정창 persistent 탭: 새 세션 양식이 아님
- 통과: 설정창을 닫으면 PAS 창에 그대로 있음
- 통과: Codex 시트: 주소 열기가 새 탭, noopener
- 통과: 다시 연결: 확인 전에는 로그인을 시작하지 않음
- 통과: 제출한 코드는 화면에 남지 않음
- 통과: invalid_code 뒤 다시 시도는 새 흐름을 시작함
- 통과: 설정창 로그인 흐름: 일회용 코드, 인증 주소, 붙여 넣은 코드가 콘솔에 없음
- 통과: 로그인 시트 360px 가로 넘침 없음
- 통과: 빈 상태(bootstrap 꺼짐): 설정창이 저절로 열리지 않음
- 통과: 빈 상태(bootstrap 꺼짐): bootstrap을 부르지 않음
- 통과: 빈 상태(연결 필요) 1280px: bootstrap을 부르지 않음
- 통과: 빈 상태(연결 필요) 1280px: 가로 넘침 없음
- 통과: 설정창을 닫은 뒤 목록을 다시 읽고 기본 세션 만들기로 이어짐
- 통과: 빈 상태(연결 필요) 360px: bootstrap을 부르지 않음
- 통과: 빈 상태(연결 필요) 360px: 가로 넘침 없음
- 통과: 빈 상태(기본 세션): bootstrap을 한 번만 부름
- 통과: 기본 세션을 만들면 그 세션으로 옮김
