# English seed notes for skills-a

## Locale and format decisions

| Card | Adaptation |
| --- | --- |
| `skill.atom_tree_cleanup.body` | Use English names for the protected project sections, "Work history" and "Mistake examples". The draft and verdict examples use English prose. The tool calls and operation keys keep their original structure. |
| `skill.card_work.body` | Use the install profile name "Seo Soyoung (PAS)" and the English persistent-session title. Translate the PAS report prefix `[별건]` as `[Out-of-scope findings]` and the handoff heading `PAS에 못 보낸 별건` as `Findings not delivered to the PAS`. They are document conventions. Translate the notice at the top of a user summary. The notice appears in the tool description, and the server uses `mode: "spoken"` to choose attribution. |
| `skill.review_code.body` | Generalize Korean composition to Enter handling during IME composition (`event.isComposing`). |
| `skill.ui_design.body` | Keep CJK word units together where applicable. Use normal word breaking for English. |
| `skill.statechart.body` | Translate visible diagram labels and keep IDs and syntax. Preserve `(어긋남 N)` because diagram-autolayout's `DEFECT_TAG` matcher reads that suffix. |
| `skill.ui_css_recipes.body` | Keep the CJK wrapping and font guidance, distinguish normal English word breaking, and translate the CSS comments. The declarations and selectors are unchanged. |

The server fixes the request completion value at `했어`. The translated card uses the approved English label "I did it" for `persistent.thread.didIt`. The English dictionary update ships separately. Bracketed event headers such as `[카드 커멘트]` and `[카드 질문 답변]`, and the startup field label `선행 카드`, retain the literal text emitted by the server.

## Screen copy without a matching dictionary entry

| Card | Korean | English in the instructions |
| --- | --- | --- |
| `skill.card_work.body` | 확인 요청: 제목 | Confirmation requested: Title |
| `skill.card_work.body` | 부탁: 제목 | Request: Title |
| `skill.card_work.body` | + 카드 | + Card |
| `skill.card_work.body` | {기다리는 것}, {시각}에 다시 확인 | {What you are waiting for}, check again at {time} |
| `skill.card_work.body` | 담당이 바뀌어 자동 재개 예약을 해제했습니다 | The assignee changed, so the scheduled resume was canceled |
| `skill.ui_design.body` | 로딩 중 | Loading |

The last row is an example of generic loading text, so it has no single product key. The worktree error `node_modules가 symlink입니다` is a server error rather than dashboard copy.
