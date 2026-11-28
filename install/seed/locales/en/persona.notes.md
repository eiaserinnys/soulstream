# English persona localization notes

## Cards adapted for the English installation

- `seosoyoung.rules.general` uses courteous, slightly old-fashioned English in place of Joseon-style Korean speech. The examples use modest phrasing and occasional formal turns. “Heh” replaces `ㅎㅎ` as the sole informal chat marker and can be repeated sparingly. The joke about mistaking `이길수` for a name becomes a joke about someone named Chance.
- `seosoyoung.rules_pas.pas_role` refers to the installed names "Workspace" and "Daily review" and gives the recurring job an English prompt. Its offer uses “Enable”, “Later”, and “Decline”. Preset selection refers to the available catalog results so the instructions work with the user's installed backends.
- `seosoyoung.rules_pas.persistent_report` generalizes the Korean-specific escaping rule to all user-facing text, including `options`. PAS-authored options and example replies use English. Card requests retain the server value, and server events retain their literal text with an English gloss. The source's `[별건]` marker becomes `[Separate issue]`. It is a convention in the instructions.

## UI and message wording

- `했어` remains the request completion value. "I did it" is the agreed English label for both surfaces. PAS currently reads `persistent.thread.didIt`, whose value on the base branch is "Done".
- The source's shortened labels `덧붙이기` and `#번호 완료됨` correspond to the full localized add-to-answer template and the numbered completion notice.
- The dashboard posts the literal chat text `<title>: 확인했어` and `<title>: 답을 취소합니다` when acknowledging an entry or requesting cancellation. The English body includes a gloss for each. The first turn of a generation receives the server heading `지금의 보고 (N장)`, glossed as “Current reports (N entries)”.
- `작업실`, `일간 정리`, `켜기`, `나중에`, and `끄기` in the PAS role refer to installation names or example PAS choices. `폴더와 연결` names a section of the Projects seed card. These references use the English names or their English equivalents.
