## 검수 전용 경계

이 별도 Expo 프로젝트는 로컬 인증 이미지 HTTP fixture 캡처용입니다. 제품 배포 대상으로 선택하지 않습니다. 네이티브 제품 진입점은 `soul-app/index.ts`이고, 일반 컴포넌트 검수 export는 `soul-app/component-review-entry.tsx`를 사용합니다. 두 진입점은 이 파일의 가짜 JWT 초기화를 실행하지 않습니다.

`checkReviewAuth`가 쿠키 인증을 확인한 뒤 로컬 entry를 시작합니다. 이 프로젝트의 Metro 설정은 `expo-secure-store`를 기존 `fixture-secure-store.ts`의 메모리 Map으로 대체합니다. 가짜 JWT는 이 검수 페이지 메모리에만 저장되며 OS Keychain이나 브라우저 로그인 쿠키를 바꾸지 않습니다. 제품용 Metro 설정에서는 이 별칭을 사용하지 않습니다.

일반 컴포넌트 검수 창의 「카드 이미지」 메뉴는 `ReviewCardImages`의 실제 CardTimeline/CardReportView 렌더를 직접 사용합니다. 메뉴에서는 인증 store를 덮지 않고 번들 이미지로 미리보기와 확대를 확인합니다. 외부 origin JWT 차단과 실제 보호 첨부의 인증 계약은 targeted 테스트 및 별도 HTTP 증거로 확인합니다.

## 기존 실행 기록

Playwright 모듈 경로는 `/home/eias/workspace/.projects/soulstream/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright`입니다.

첫 실행은 `executablePath` 지정 없이 Playwright 기본 Chromium을 선택했습니다. 이 설치의 `chromium.executablePath()` 조회값은 `/home/eias/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`입니다. 한 번의 보정에서 `executablePath`를 CLI 필수 인자로 받고 `/home/eias/.cache/ms-playwright/chromium-1148/chrome-linux/chrome`을 지정했으며 기존 `--no-sandbox`에 `--disable-dev-shm-usage`를 추가했습니다. 제품 코드, fixture 데이터, viewport, assertion은 바꾸지 않았습니다. 두 실행은 탭 충돌로 중단됐습니다.

이후 부모가 `/tmp` 용량 부족을 확인하고 `TMPDIR=/home/eias/workspace/.local/tmp/card-image-browser` 환경에서 독립 캡처를 수행했습니다. 폰·태블릿 두 케이스의 접기·펼치기·썸네일 및 본문 확대·상대/절대 커멘트 열기는 RN web에서 확인했습니다. 네이티브 헤더 전송이나 실제 iOS 증거는 아니며, 본문 간격·정렬 보완 후 확대본문 한 경로의 재확인은 부모가 담당합니다.
