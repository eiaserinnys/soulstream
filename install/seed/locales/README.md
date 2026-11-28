# 설치용 atom seed 번역

이 디렉터리는 새 Soulstream 설치에 들어갈 기본 지침과 스킬의 언어를 관리한다. 원문은 `install/seed/atom-seed.json`의 한국어다. 한국어 설치는 이 파일을 그대로 사용한다.

## 작업 시작

리포 루트에서 언어와 맡은 묶음을 지정한다. 언어 코드는 `en`, `ja`, `zh-Hans`다.

```sh
node install/seed/locales/tool.mjs worklist --lang en --chunk persona
node install/seed/locales/tool.mjs check --lang en --chunk persona
node install/seed/locales/tool.mjs check --lang en
```

`worklist`는 seed 순서로 번역할 카드를 보여 준다. `[todo]`는 덮어쓰기 파일에 아직 없는 카드이고, `[done]`은 이미 들어 있는 카드다. 목록의 제목과 본문은 언제나 한국어 원문이다. `Title (keep)`이 붙은 제목은 원문 그대로 둔다. `check`는 덮어쓰기를 검증하고 원본 entry 수, 원본 본문의 유니코드 코드 포인트 수, 번역을 채운 카드 수와 비율을 보여 준다. entry 수에는 심링크도 포함된다.

`chunks.json`에는 `core`, `catalogs`, `persona`, `skills-a`, `skills-b`가 있다. 배열 속 키는 그 키 자체와 점(`.`)으로 구분된 하위 키를 맡는다. 번역 단위는 자신이 맡은 언어와 묶음의 파일을 편집한다.

## 파일 형식

`install/seed/locales/<lang>/<chunk>.json`에 다음 형태로 작성한다. 예시의 키는 `persona`에 있다.

```json
{
  "schema_version": 1,
  "lang": "en",
  "chunk": "persona",
  "entries": {
    "seosoyoung.root": {
      "title": "<번역한 제목>",
      "content": "<번역한 본문>"
    }
  }
}
```

- 원본 카드의 정확한 키 아래에 `title`과 `content`를 모두 쓴다. 원본 본문이 빈 카드에도 `"content": ""`을 쓴다. 제목은 1~50 유니코드 코드 포인트다. 태그를 옮길 때는 선택 필드 `"tags": ["…"]`에 태그 배열 전체를 쓴다. 이 필드를 생략하면 원본 태그를 쓴다.
- 심링크는 대상 카드의 번역을 그대로 보여 준다. 목록에 있는 카드 키만 넣는다. 부모, 순서, 심링크 대상과 내보내기 키는 원본이 정한다.
- 묶음이 비어 있으면 파일을 만들 필요가 없다. 언어에 누락된 카드가 있어도 작성 중 `check`를 실행할 수 있다. 완성으로 표시된 언어는 모든 카드의 제목과 본문, 모든 설치기 문구가 필요하다.
- 세 프로필의 표시 이름, 일간 정리의 이름과 프롬프트, 기본 폴더 이름(`workspaceFolder`), 코딩 에이전트 로그인 탭 경로(`codingAgentsPath`)는 `<lang>/installer.json`에 쓴다. [한국어 설치기 문구](ko/installer.json)의 구조와 키를 따른다. `codingAgentsPath`는 해당 언어의 `settings.json`에서 `title`과 `tabs.coding_agents.label`을 ` → `로 잇는다.
- 묶음 검사를 마치면 전체 `check --lang <lang>`으로 합쳐진 진행률을 확인한다. 담당자는 검수한 뒤 `languages.json`의 완성 표시를 관리한다. 언어별 마무리 단위는 해당 언어의 모든 묶음과 `installer.json`이 main에 들어온 뒤 기준본의 지시에 따라 `complete`를 올린다. 개별 묶음의 번역 단위는 완성 표시를 바꾸지 않는다.

## 번역 규칙

1. 영어, 일본어, 중국어 간체 모두 한국어 원문에서 바로 옮긴다.
2. `{{node_id:<key>}}` 자리표시자의 키와 횟수를 보존한다. 코드 블록, 명령, 경로, 도구 이름, JSON 키, 파일 이름 제목과 스킬 식별자는 그대로 둔다. 원본 seed의 공개용 금지 패턴은 번역에도 적용한다. 예를 들어 실제 UUID, 사설 경로, 내부 프로젝트 이름과 개인 식별 정보는 넣지 않는다.
3. 대시보드 화면 이름은 `packages/i18n/src/locales/<lang>/` 사전의 값을 그대로 쓴다. 설정 안내(`common.soulstream_guide.settings`)는 `settings.json`의 그룹 이름을 `## <그룹>` 헤딩에 쓰고 각 탭을 `- <탭>:`으로 시작한다. 관리자 전용 탭은 콜론 앞에 언어별 표시를 붙인다. 한국어는 `(관리자)`, 영어는 ` (Admin)`, 일본어는 `（管理者）`, 중국어 간체는 `（管理员）`을 쓴다.
4. 한국어 표기 규칙(`common.rules.korean_literals`), Codex 말버릇 교정, 한국어 줄바꿈 CSS 설명처럼 원어에 의존하는 지침은 대상 언어의 사례와 관례에 맞게 고친다. 같은 디렉터리의 `<chunk>.notes.md`에 바꾼 카드 키와 까닭을 적는다.
5. `persona`의 조선풍 말투는 대상 언어에서 예스럽고 공손하게 들리는 말투로 옮긴다. 이름과 프로필 표기는 [용어집](GLOSSARY.md)을 따른다.
6. 문장을 다듬을 때 영어는 `sentence-english-docs`, 일본어는 `sentence-japanese-docs`, 중국어 간체는 `sentence-chinese-docs` 스킬을 사용한다.
7. 한국어 이외의 완성 언어에서는 서버나 렌더러가 그대로 내보내거나 비교하는 한글 값만 남긴다. `hangul-allowlist.json`에 원문 `text`, 유지하는 `reason`, 근거 `source`(경로와 줄 번호)를 적는다. 허용 목록에도 공개 seed 금지 규칙이 적용된다. 각 값은 한국어 이외의 완성 언어에서 한 번 이상 쓰여야 한다.

## 설치 시 확인

Bash는 `--lang <lang>`, Windows 전체 설치기는 `-Lang <lang>`을 받는다. 완성 언어만 설치할 수 있다. 옵션이 없으면 기존 atom seed state의 언어를 따른다. 새 설치의 기본값은 `LC_ALL`, `LANG` 순으로 확인한다. 한국어 로케일은 `ko`, 일본어는 `ja`, 중국어는 `zh-Hans`, 나머지는 `en`이다. 해당 언어가 미완성이면 `ko`를 사용한다. 터미널에 완성 언어가 둘 이상 있으면 설치기가 선택을 묻는다.
