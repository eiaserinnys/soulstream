# 설치용 atom seed 용어집

공용 용어는 `packages/i18n/GLOSSARY.md`에서 가져왔다. 영역별 용어는 `packages/i18n/glossary/`를 참고한다. 일본어와 중국어 간체에서 대시보드의 기능이나 탭을 직접 가리킬 때는 그 언어의 UI 사전 표기를 쓴다.

| 한국어 | English |
| :--- | :--- |
| 카드 | Card |
| 세션 | Session |
| 폴더 | Folder |
| 영구 세션 | Persistent session |
| 노드 | Node |
| 에이전트 | Agent |
| 검수 | Review |
| 대기열 | Queue |
| 개입 | Intervention |
| 지침 | Instructions |

## 페르소나와 설치 프로필

| 용도 | ID | 한국어 | English | 日本語 | 简体中文 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 페르소나와 기본 프로필 | `seosoyoung` | 서소영 | Seo Soyoung | ソ・ソヨン | Seo Soyoung |
| 영구 세션 기본 프로필 | `seosoyoung-pas` | 서소영 (PAS) | Seo Soyoung (PAS) | ソ・ソヨン(PAS) | Seo Soyoung (PAS) |
| 카드 실행 판단 프로필 | `card-orchestrator` | 카드 오케스트레이터 | Card orchestrator | カードオーケストレーター | 卡片编排器 |

카드 실행 판단 프로필을 옮길 때는 atom 카드의 제목과 `installer.json`의 표시 이름을 맞춘다. 프로필 ID와 `PAS`는 그대로 둔다.
