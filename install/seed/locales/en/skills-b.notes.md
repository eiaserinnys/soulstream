# English skills-b translation notes

## Language-specific rewrites

| Card key | Reason |
| :--- | :--- |
| `skill.atom_search.body` | Use English search examples for an English knowledge base. Keep the same batch-processing intent and OR expansion. |
| `skill.agent_delegation.body` | Replace the Korean speech-level instruction with formal, courteous, old-fashioned English for the Seo Soyoung persona. |
| `skill.modern_web_guidance.body` | Apply the Enter guard to IME composition through `event.isComposing`. Keep Soulstream's Enter and Shift+Enter behavior. |
| `skill.html_make.body` | Use `lang="en"` for English documents and set `lang` to match the document language. Keep `word-break: keep-all; overflow-wrap: break-word` for Korean text. |

## Display text and stored values

- `skill.daily_review` and `skill.daily_review.body` use the installer names "Daily review" and "Workspace". "모두 진행", "일부만", and "오늘은 건너뜀" are agent-authored options, with no locale dictionary entries. Use "Do all", "Do some", and "Skip today". The agent-authored check item "새로 닫힌 카드 N장으로 건너뜀" becomes "Skipped because only N cards closed".
- `skill.git_setup.body` keeps the request answer value `했어` and describes its English display as "I did it". The server fixes the value in `orch-server-ts/src/cards/card_control_plane_service.ts`. The card-detail action at `unified-dashboard/client/v3/CardQuestionBlock.tsx:182` is still a literal in the baseline. The PAS label in `persistent.thread.didIt` reads "Done" in the baseline. The shared English wording follows the card's agreed label.
- The prefix `[별건]` occurs as an agent convention in `skill.card_work.body` and `seosoyoung.rules_pas.persistent_report`. No code match was found. These cards are outside skills-b and both use the agreed English prefix `[Separate issue]`.

## Templates and references

- `skill.retrospective.body`, `skill.work_plan.body`, and `skill.general_create_rule.body` translate the template headings and labels and the human-readable placeholder instructions. Preserve template structure and literal identifiers. No external literal reader for those template headings was found in code or other seed cards.
- The `section: "담당과 소속"` line in `skill.skill_link_blocks.body` is a nested example. `담당과 소속` is a heading in `common.rules.workflow_md`, but does not occur as a heading in the example's `card-work` target. The English example explains that an active `include` must copy the target heading verbatim. The compiler compares headings in `orch-server-ts/src/skills/link_blocks.ts:216`. Keep the original runtime markers such as `링크:` where the examples show actual compiler output.
