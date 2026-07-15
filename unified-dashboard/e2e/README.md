# Unified dashboard E2E 수명 규칙

## 공식 Playwright E2E

`*.e2e.ts`는 `@playwright/test`의 `test` fixture를 사용한다. runner가 browser와 context 수명을 관리하므로 standalone harness로 다시 감싸지 않는다.

## Standalone 진단

runner 밖에서 Chromium이 필요한 진단은 `playwright-lifecycle-harness.mjs`의 `runPlaywrightLifecycle`만 사용한다.

리포와 lockfile은 standalone용 `playwright`를 설치하지 않는다. 기본 launcher와 데모는 기존 공식 E2E와 마찬가지로 실행 환경에서 Playwright를 해석할 수 있을 때만 동작한다. 모듈 자체와 launcher를 주입하는 단위 테스트는 Playwright 없이 로드·실행할 수 있다.

```js
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";

await runPlaywrightLifecycle({
  lockName: "my-standalone-probe",
}, async ({ browser, signal }) => {
  signal.throwIfAborted();
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:4173");
});
```

기본 계약:

- 같은 `lockName`의 중복 실행은 browser 시작 전에 실패한다.
- launch, context/page/route 준비, 본 실행 전체에 120초 타임아웃을 적용한다.
- 성공, callback 실패, timeout, SIGINT, SIGTERM 모두 browser cleanup을 거친다.
- 종료 전 관찰된 Chromium PID가 실제로 사라졌는지 확인한다.

수명 계약의 실행 예시는 `node e2e/playwright-lifecycle-harness.demo.mjs`다. 정상 실행, callback 실패, 중복 실행 차단 세 경우를 순차 검증하고 각 경우의 잔존 프로세스가 0이 아니면 실패한다.
