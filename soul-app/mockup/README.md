# 앱 시안 만들기

실제 앱 컴포넌트를 웹 정적 묶음으로 내보내 pages에 발행합니다. 로그인과 앱 시작 절차 없이 검수 창의 로컬 데이터를 사용합니다.

1. `src/mockups/proof-343`을 복사해 `src/mockups/<이름>`을 만듭니다.
2. `src/mockups/index.ts`의 레지스트리에 이름과 동적 import 한 줄을 추가합니다.
3. `MockupShell` 안에 실제 컴포넌트를 올립니다. 색, 글자 크기, 간격을 시안에 새로 적지 않고 기존 컴포넌트와 토큰을 사용합니다. 서버가 필요한 동작은 검수 창의 로컬 fixture로 처리합니다.
4. 리포 루트에서 내보냅니다. 발행 경로는 끝 슬래시 없는 `/d/<slug>`여야 합니다.

```bash
MOCKUP=proof-343 MOCKUP_BASE_URL=/d/mockup-app-proof-343-x9k2 npm --prefix soul-app run export:mockup
```

`soul-app/` 안에서는 `MOCKUP=<이름> MOCKUP_BASE_URL=/d/<slug> node scripts/export-mockup.mjs`로 실행합니다. 결과는 `soul-app/dist-mockups/<이름>/`입니다. `?theme=dark`로 어두운 테마, `?theme=light`로 밝은 테마를 봅니다.

5. 리포 루트에서 드래프트로 발행합니다.

```bash
python3 $AGENT_COMMON_FILES_DIR/skills/html-publish/scripts/publish.py --dir soul-app/dist-mockups/<이름> --doc <slug> --title "<제목>" --draft
```

웹 시안은 `unified-dashboard/mockups/README.md`를 봅니다.

## 실기기와 다른 곳

- iOS 유리 효과는 웹 대체 표현입니다.
- 시스템 알림창과 액션 시트는 뜨지 않습니다.
- 키보드는 없습니다.
- 글꼴은 보는 기기의 시스템 글꼴입니다.
