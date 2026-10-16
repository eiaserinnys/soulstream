# 시안 묶음

실제 컴포넌트와 실제 CSS로 시안을 만들고 정적 파일 묶음으로 내보낸다. 손으로 다시 그린 HTML은 쓰지 않는다.

## 구조

| 경로 | 역할 |
|---|---|
| `../vite.mockup.config.ts` | 시안 전용 빌드. 별칭과 define은 운영 `vite.config.ts`에서 가져온다 |
| `_shell/mockup.css` | 운영 진입점과 같은 순서로 같은 CSS를 불러온다 |
| `_shell/mock-env.ts` | 서버 없이 뜨게 하는 환경. 테마, 서버 호출 가짜 응답, 정적 자원 주소 옮기기 |
| `_shell/MockupShell.tsx` | 화면 바탕. 검수 창과 같은 겉틀 |
| `_shell/host.tsx` | 완료 기간 선택과 같은 Button 표시로 테마와 화면 폭을 바꾸는 바깥 틀 |
| `_shell/host.css` | 바깥 틀의 전체 높이와 배치 |
| `<이름>/frame.html`, `frame.tsx` | 시안 본문. 실제 컴포넌트를 올린다 |
| `<이름>/index.html` | 바깥 틀 진입점. `_shell/host.tsx`를 부른다 |
| `<이름>/og.png` | 발행 페이지의 미리보기 그림 |
| `compare-captures.py` | 운영 빌드와 시안 묶음을 찍은 PNG 쌍을 견준다 |

## 시안 만들기

1. `mockups/proof-343`을 복사해 `mockups/<이름>`을 만든다.
2. `index.html`에서 제목과 설명, `og:url`, `og:image`의 발행 슬러그를 고친다.
3. `frame.tsx`에서 실제 컴포넌트를 불러 `mountMockup(...)`에 넘긴다. 같은 역할의 컴포넌트가 있으면 그대로 쓰고, 새 구성은 `client/` 아래 실제 컴포넌트로 쓴다. 색, 글자 크기, 간격을 시안 파일에 새로 적지 않는다.
4. 컴포넌트가 쓰는 CSS를 같이 불러온다. 이 리포에서는 컴포넌트의 CSS를 그 컴포넌트 파일이 아니라 그것을 그리는 화면 쪽 모듈이 불러오는 경우가 많아서, 컴포넌트만 따로 올리면 CSS가 빠져 꾸며지지 않은 모습으로 나온다. 실제 화면이 불러오는 CSS 파일을 `frame.tsx`에서 같은 순서로 import한다. 예를 들어 읽기 전용 카드 목록(`ReadOnlyCardList`)은 `v3-cards.css`, `v3-context-succession.css`, `v3-postit-cards.css`가 필요하다. 어느 파일인지는 컴포넌트가 쓰는 클래스 이름을 `client/` 아래 CSS에서 찾으면 나온다. 화면 전체를 올릴 때는 그 화면의 최상위 컴포넌트를 import하면 딸린 CSS가 함께 온다.
5. 데이터는 props로 준다. `client/v3/components-review-fixtures.ts`의 값을 먼저 쓴다. 서버를 부르는 컴포넌트는 `mockApi({ "GET /api/...": 응답 })`와 `mockImages(...)`로 응답을 등록한다. 답이 없는 호출은 콘솔과 `window.__mockupUnmocked`에 남는다.
6. 미리보기 그림은 1200×630으로 만든다. `html-publish` 스킬의 `make_og.py`를 쓴다.
7. 빌드: `MOCKUP=<이름> vite build --config vite.mockup.config.ts`. 결과는 `dist-mockups/<이름>/`이다.
8. 개발 중에는 `MOCKUP=<이름> vite --config vite.mockup.config.ts`로 띄워 `frame.html`을 연다.

## 보는 법

- `index.html`: 테마와 화면 폭을 바꾼다. 화면 폭은 맞춤, 휴대폰 390, 태블릿 820, 데스크톱 1440이다. 창보다 넓은 폭은 줄여서 보여 준다.
- `frame.html?theme=light|dark`: 본문만 연다. 실제 기기에서는 이 주소를 연다.
- `?glass=css`: WebGL 유리를 끄고 CSS 유리만 쓴다. 화소 비교에 쓴다.

## 운영과 같은지 확인

`mockups/proof-343`은 운영 검수 창(`/components`)의 본문을 그대로 올린 시안이다. 바깥 틀이나 빌드 설정을 바꾸면 운영 빌드와 견준다.

```bash
vite build
MOCKUP=proof-343 vite build --config vite.mockup.config.ts
MOCKUP_PARITY_OUTPUT=<출력 폴더> playwright test --config playwright.mockup.config.ts
python3 mockups/compare-captures.py <출력 폴더>
```

비교 결과에서 `layoutDifferent`가 빈 목록이어야 한다.

## 발행

```bash
python3 $AGENT_COMMON_FILES_DIR/skills/html-publish/scripts/publish.py --dir dist-mockups/<이름> --doc <slug> --title "<제목>" --draft --review-path frame.html
```

코멘트는 본문인 `frame.html`에만 붙는다. 발행 슬러그는 추측하기 어렵도록 끝에 임의의 글자를 붙인다.

발행한 주소를 브라우저로 열어 확인한다. 카드, 버튼, 입력의 모습이 검수 창(`/components`)의 같은 견본과 다르거나 글자만 줄줄이 나오면 CSS가 빠진 것이다. 답이 없는 서버 호출은 `window.__mockupUnmocked`에서 본다.

## 앱 시안

앱 시안은 `soul-app/mockup/README.md`를 참고한다.

## 한계

- 운영 주소를 통째로 끼우는 견본(`<iframe src="/persistent">`)은 뜨지 않는다. 화면 전체 시안은 그 화면의 컴포넌트를 직접 올리고 서버 응답을 등록한다.
- 실시간 스트림은 열리기만 하고 아무것도 보내지 않는다.
